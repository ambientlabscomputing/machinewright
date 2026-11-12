/**
 * The command palette: one overlay with three list modes chosen by the
 * query's leading character, VS Code style —
 *
 *   `>text`  commands          (Cmd+Shift+P opens with the `>` prefilled)
 *   `%text`  find in files     (Cmd+Shift+F opens with the `%` prefilled)
 *   `text`   quick-open files  (Cmd+P)
 *
 * — plus a "prompt" mode: a titled single-value input (used by New File).
 *
 * Keyboard: typing and Enter go through the text field; Up/Down/Escape are
 * intercepted natively (see MachinewrightShortcutsModule) because a
 * WebView-heavy window cannot rely on React Native key events, and arrive
 * here via the imperative `PaletteHandle`/`onClose`.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ScrollView } from "react-native";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Overlay, Panel, Stack, Text, TextField } from "../design-system/native";
import { formatChord } from "../commands/chords";
import { rankByFuzzy } from "../commands/fuzzy";
import { rankFiles } from "../commands/fileIndex";
import type { Command } from "../commands/registry";
import type { TextMatch } from "../native/BundledAssets";

export type PaletteMode =
  | { readonly kind: "list"; readonly initialQuery: string }
  | {
      readonly kind: "prompt";
      readonly title: string;
      readonly placeholder: string;
      readonly initialValue: string;
      readonly onSubmit: (value: string) => void | Promise<void>;
    };

export interface PaletteHandle {
  /** Moves the highlighted row; wraps at both ends. */
  move(delta: 1 | -1): void;
}

export interface CommandPaletteProps {
  readonly mode: PaletteMode;
  readonly commands: readonly Command[];
  /** Project-relative file paths for quick-open; `null` while unknown/loading. */
  readonly files: readonly string[] | null;
  readonly hasProject: boolean;
  readonly onClose: () => void;
  readonly onRunCommand: (command: Command) => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onOpenMatch: (match: TextMatch) => void;
  readonly onSearchText: (query: string) => Promise<readonly TextMatch[]>;
}

interface PaletteItem {
  readonly key: string;
  readonly text: string;
  readonly highlight: readonly number[];
  readonly detail?: string;
  readonly activate: () => void;
}

const SEARCH_DEBOUNCE_MS = 200;
const MAX_VISIBLE_HEIGHT = 340;

function HighlightedText({ text, indices }: { readonly text: string; readonly indices: readonly number[] }) {
  const matched = new Set(indices);
  const segments: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = matched.has(i);
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) last.text += text.charAt(i);
    else segments.push({ text: text.charAt(i), hit });
  }
  return (
    <Text numberOfLines={1}>
      {segments.map((segment, index) =>
        segment.hit ? (
          <Text key={index} tone="action">
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}

export const CommandPalette = forwardRef<PaletteHandle, CommandPaletteProps>(function CommandPalette(props, ref) {
  const { mode, onClose } = props;
  return (
    <Overlay onDismiss={onClose}>
      <Panel surface="panel" padding="sm" bordered elevated>
        {mode.kind === "list" ? <ListPalette ref={ref} {...props} initialQuery={mode.initialQuery} /> : <PromptPalette {...mode} onClose={onClose} />}
      </Panel>
    </Overlay>
  );
});

const ListPalette = forwardRef<PaletteHandle, CommandPaletteProps & { readonly initialQuery: string }>(
  function ListPalette(
    { initialQuery, commands, files, hasProject, onRunCommand, onOpenFile, onOpenMatch, onSearchText },
    ref,
  ) {
    // The mode is state of its own, not a prefix inside the field: macOS
    // selects a text field's contents on focus, so a prefilled ">" would be
    // wiped by the first keystroke. Typing a prefix into an empty files-mode
    // field still switches modes (below).
    type Kind = "commands" | "text" | "files";
    const [kind, setKind] = useState<Kind>(
      initialQuery.startsWith(">") ? "commands" : initialQuery.startsWith("%") ? "text" : "files",
    );
    const [term, setTerm] = useState(/^[>%]/.test(initialQuery) ? initialQuery.slice(1) : initialQuery);
    const onChangeText = useCallback((next: string) => {
      if (next.startsWith(">")) {
        setKind("commands");
        setTerm(next.slice(1));
      } else if (next.startsWith("%")) {
        setKind("text");
        setTerm(next.slice(1));
      } else {
        setTerm(next);
      }
    }, []);
    const [selected, setSelected] = useState(0);
    const [textResults, setTextResults] = useState<{ query: string; matches: readonly TextMatch[] } | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    // Debounced, stale-safe text search: only the latest query's result is kept.
    useEffect(() => {
      if (kind !== "text") return;
      const trimmed = term.trim();
      if (trimmed.length === 0) {
        setTextResults(null);
        setSearching(false);
        return;
      }
      let cancelled = false;
      setSearching(true);
      const timer = setTimeout(() => {
        onSearchText(trimmed).then(
          (matches) => {
            if (cancelled) return;
            setTextResults({ query: trimmed, matches });
            setSearchError(null);
            setSearching(false);
          },
          (error: unknown) => {
            if (cancelled) return;
            setSearchError(String(error));
            setSearching(false);
          },
        );
      }, SEARCH_DEBOUNCE_MS);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [kind, term, onSearchText]);

    const items: readonly PaletteItem[] = useMemo(() => {
      if (kind === "commands") {
        return rankByFuzzy(
          commands,
          term,
          (command) => (command.category ? `${command.category}: ${command.title}` : command.title),
        ).map(({ item, match }) => ({
          key: item.id,
          text: item.category ? `${item.category}: ${item.title}` : item.title,
          highlight: match.indices,
          detail: item.shortcut ? formatChord(item.shortcut) : undefined,
          activate: () => onRunCommand(item),
        }));
      }
      if (kind === "text") {
        return (textResults?.matches ?? []).map((match, index) => ({
          key: `${match.path}:${match.line}:${match.column}:${index}`,
          text: match.text.trim(),
          highlight: [],
          detail: `${match.path}:${match.line}`,
          activate: () => onOpenMatch(match),
        }));
      }
      return rankFiles(files ?? [], term).map((entry) => {
        const slash = entry.path.lastIndexOf("/");
        // Show "name  directory" with the match highlighted in the name when it matched there.
        const name = entry.path.slice(slash + 1);
        return {
          key: entry.path,
          text: name,
          highlight: entry.nameIndices,
          detail: slash >= 0 ? entry.path.slice(0, slash) : undefined,
          activate: () => onOpenFile(entry.path),
        };
      });
    }, [kind, term, commands, files, textResults, onRunCommand, onOpenFile, onOpenMatch]);

    useEffect(() => setSelected(0), [kind, term]);
    const clampedSelected = Math.min(selected, Math.max(items.length - 1, 0));

    const scrollRef = useRef<ScrollView>(null);
    const scrollY = useRef(0);
    const rowLayouts = useRef<Map<number, { y: number; height: number }>>(new Map());

    useImperativeHandle(
      ref,
      () => ({
        move: (delta) => {
          if (items.length === 0) return;
          setSelected((current) => (Math.min(current, items.length - 1) + delta + items.length) % items.length);
        },
      }),
      [items.length],
    );

    useEffect(() => {
      const layout = rowLayouts.current.get(clampedSelected);
      if (!layout) return;
      if (layout.y < scrollY.current) scrollRef.current?.scrollTo({ y: layout.y, animated: false });
      else if (layout.y + layout.height > scrollY.current + MAX_VISIBLE_HEIGHT) {
        scrollRef.current?.scrollTo({ y: layout.y + layout.height - MAX_VISIBLE_HEIGHT, animated: false });
      }
    }, [clampedSelected, items]);

    const activateSelected = useCallback(() => {
      items[clampedSelected]?.activate();
    }, [items, clampedSelected]);

    const placeholder =
      kind === "commands" ? "Run a command" : kind === "text" ? "Find in files" : "Open file by name  (> commands, % text)";
    const emptyMessage = (() => {
      if (items.length > 0) return null;
      if (kind === "commands") return "No matching commands";
      if (kind === "text") {
        if (!hasProject) return "Open a project to search its files";
        if (term.trim().length === 0) return "Type to search every file in the project";
        if (searchError) return `Search failed: ${searchError}`;
        return searching ? "Searching…" : "No matches";
      }
      if (!hasProject) return "Open a project (⌘O) to browse its files";
      return files === null ? "Indexing files…" : "No matching files";
    })();

    return (
      <Stack gap="sm">
        <Text variant="label" tone="secondary">
          {kind === "commands" ? "COMMANDS" : kind === "text" ? "FIND IN FILES" : "GO TO FILE"}
        </Text>
        <TextField
          value={term}
          onChangeText={onChangeText}
          onSubmit={activateSelected}
          placeholder={placeholder}
          autoFocus
          accessibilityLabel="Command palette"
        />
        {emptyMessage ? (
          <Text tone="secondary">{emptyMessage}</Text>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={{ maxHeight: MAX_VISIBLE_HEIGHT }}
            scrollEventThrottle={16}
            onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
              scrollY.current = event.nativeEvent.contentOffset.y;
            }}
          >
            {items.map((item, index) => (
              <Panel
                key={item.key}
                surface={index === clampedSelected ? "control" : "panel"}
                padding="xs"
                onLayout={(event: LayoutChangeEvent) => {
                  const { y, height } = event.nativeEvent.layout;
                  rowLayouts.current.set(index, { y, height });
                }}
              >
                <Stack direction="row" gap="md" justify="space-between" align="center">
                  <Stack flex={1}>
                    <Text numberOfLines={1} onPress={item.activate}>
                      {kind === "text" ? item.text : <HighlightedText text={item.text} indices={item.highlight} />}
                    </Text>
                  </Stack>
                  {item.detail ? (
                    <Text variant="label" tone="secondary" numberOfLines={1}>
                      {item.detail}
                    </Text>
                  ) : null}
                </Stack>
              </Panel>
            ))}
          </ScrollView>
        )}
      </Stack>
    );
  },
);

function PromptPalette({
  title,
  placeholder,
  initialValue,
  onSubmit,
  onClose,
}: Extract<PaletteMode, { kind: "prompt" }> & { readonly onClose: () => void }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      Promise.resolve(onSubmit(trimmed)).then(onClose, (reason: unknown) => setError(String(reason)));
    },
    [onSubmit, onClose],
  );
  return (
    <Stack gap="sm">
      <Text variant="label" tone="secondary">
        {title}
      </Text>
      <TextField
        value={value}
        onChangeText={(next) => {
          setValue(next);
          setError(null);
        }}
        onSubmit={submit}
        placeholder={placeholder}
        autoFocus
        monospace
        accessibilityLabel={title}
      />
      {error ? <Text tone="action">{error}</Text> : <Text variant="label" tone="secondary">Enter to confirm · Esc to cancel</Text>}
    </Stack>
  );
}
