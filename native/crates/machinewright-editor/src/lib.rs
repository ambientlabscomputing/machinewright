use machinewright_app::EditorDiagnostic;
use tree_sitter::{InputEdit, Node, Parser, Point, Tree};

pub struct PythonSyntax {
    parser: Parser,
    tree: Option<Tree>,
    source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub start_byte: usize,
    pub end_byte: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
    pub start_byte: usize,
    pub old_end_byte: usize,
    pub replacement: String,
}

impl PythonSyntax {
    pub fn new() -> Self {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .expect("bundled Python grammar is compatible");
        Self {
            parser,
            tree: None,
            source: String::new(),
        }
    }

    pub fn update(&mut self, source: &str) -> Vec<EditorDiagnostic> {
        // Callers currently provide a complete replacement. Reusing the prior tree
        // without applying an InputEdit can preserve stale nodes and hide syntax
        // errors, so perform a fresh parse until the editor supplies incremental
        // edits explicitly.
        self.tree = self.parser.parse(source, None);
        self.source.clear();
        self.source.push_str(source);
        let mut diagnostics = Vec::new();
        if let Some(tree) = &self.tree {
            collect_errors(tree.root_node(), &mut diagnostics);
            if tree.root_node().has_error() && diagnostics.is_empty() {
                diagnostics.push(EditorDiagnostic {
                    message: "incomplete Python syntax".into(),
                    start_byte: source.len().saturating_sub(1),
                    end_byte: source.len(),
                });
            }
        }
        diagnostics
    }

    pub fn apply_edit(&mut self, edit: &TextEdit) -> Result<Vec<EditorDiagnostic>, EditError> {
        if edit.start_byte > edit.old_end_byte
            || edit.old_end_byte > self.source.len()
            || !self.source.is_char_boundary(edit.start_byte)
            || !self.source.is_char_boundary(edit.old_end_byte)
        {
            return Err(EditError::InvalidRange);
        }
        let start_position = point_at(&self.source, edit.start_byte);
        let old_end_position = point_at(&self.source, edit.old_end_byte);
        let mut updated = self.source.clone();
        updated.replace_range(edit.start_byte..edit.old_end_byte, &edit.replacement);
        let new_end_byte = edit.start_byte + edit.replacement.len();
        let new_end_position = point_at(&updated, new_end_byte);
        if let Some(tree) = self.tree.as_mut() {
            tree.edit(&InputEdit {
                start_byte: edit.start_byte,
                old_end_byte: edit.old_end_byte,
                new_end_byte,
                start_position,
                old_end_position,
                new_end_position,
            });
        }
        self.tree = self.parser.parse(&updated, self.tree.as_ref());
        self.source = updated;
        Ok(self.diagnostics())
    }

    fn diagnostics(&self) -> Vec<EditorDiagnostic> {
        let mut diagnostics = Vec::new();
        if let Some(tree) = &self.tree {
            collect_errors(tree.root_node(), &mut diagnostics);
            if tree.root_node().has_error() && diagnostics.is_empty() {
                diagnostics.push(EditorDiagnostic {
                    message: "incomplete Python syntax".into(),
                    start_byte: self.source.len().saturating_sub(1),
                    end_byte: self.source.len(),
                });
            }
        }
        diagnostics
    }

    pub fn structural_selection(&self, start: usize, end: usize) -> Option<std::ops::Range<usize>> {
        let root = self.tree.as_ref()?.root_node();
        let node = root.descendant_for_byte_range(start, end)?;
        let parent = if node.start_byte() == start && node.end_byte() == end {
            node.parent()?
        } else {
            node
        };
        Some(parent.start_byte()..parent.end_byte())
    }

    pub fn symbols(&self) -> Vec<Symbol> {
        let mut symbols = Vec::new();
        if let Some(tree) = &self.tree {
            collect_symbols(tree.root_node(), self.source.as_bytes(), &mut symbols);
        }
        symbols
    }

    pub fn matching_delimiter(&self, byte: usize) -> Option<usize> {
        let tree = self.tree.as_ref()?;
        let node = tree.root_node().descendant_for_byte_range(byte, byte + 1)?;
        if node.ancestors().any(|ancestor| {
            matches!(
                ancestor.kind(),
                "string" | "comment" | "string_content" | "escape_sequence"
            )
        }) {
            return None;
        }
        let bytes = self.source.as_bytes();
        let opening = *bytes.get(byte)?;
        let (close, direction) = match opening {
            b'(' => (b')', 1),
            b'[' => (b']', 1),
            b'{' => (b'}', 1),
            b')' => (b'(', -1),
            b']' => (b'[', -1),
            b'}' => (b'{', -1),
            _ => return None,
        };
        let mut depth = 0i32;
        let indices: Box<dyn Iterator<Item = usize>> = if direction > 0 {
            Box::new(byte..bytes.len())
        } else {
            Box::new((0..=byte).rev())
        };
        for index in indices {
            let candidate = tree
                .root_node()
                .descendant_for_byte_range(index, index + 1)?;
            if candidate
                .ancestors()
                .any(|ancestor| matches!(ancestor.kind(), "string" | "comment" | "string_content"))
            {
                continue;
            }
            let value = bytes[index];
            if value == opening {
                depth += 1;
            }
            if value == close {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
        }
        None
    }
}

trait NodeAncestors<'a> {
    fn ancestors(self) -> Ancestors<'a>;
}

impl<'a> NodeAncestors<'a> for Node<'a> {
    fn ancestors(self) -> Ancestors<'a> {
        Ancestors(Some(self))
    }
}

struct Ancestors<'a>(Option<Node<'a>>);

impl<'a> Iterator for Ancestors<'a> {
    type Item = Node<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        let current = self.0?;
        self.0 = current.parent();
        Some(current)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EditError {
    #[error("edit range is outside the document or not on UTF-8 boundaries")]
    InvalidRange,
}

fn point_at(source: &str, byte: usize) -> Point {
    let prefix = &source[..byte];
    let row = prefix.bytes().filter(|byte| *byte == b'\n').count();
    let column = prefix
        .rsplit_once('\n')
        .map_or(prefix.len(), |(_, tail)| tail.len());
    Point::new(row, column)
}

impl Default for PythonSyntax {
    fn default() -> Self {
        Self::new()
    }
}

fn collect_errors(node: Node<'_>, diagnostics: &mut Vec<EditorDiagnostic>) {
    if node.is_error() || node.is_missing() {
        diagnostics.push(EditorDiagnostic {
            message: if node.is_missing() {
                format!("missing {}", node.kind())
            } else {
                "invalid Python syntax".into()
            },
            start_byte: node.start_byte(),
            end_byte: node.end_byte().max(node.start_byte() + 1),
        });
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_errors(child, diagnostics);
    }
}

fn collect_symbols(node: Node<'_>, source: &[u8], symbols: &mut Vec<Symbol>) {
    if matches!(node.kind(), "function_definition" | "class_definition")
        && let Some(name) = node.child_by_field_name("name")
        && let Ok(text) = name.utf8_text(source)
    {
        symbols.push(Symbol {
            name: text.into(),
            kind: node.kind().into(),
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
        });
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_symbols(child, source, symbols);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_syntax_and_extracts_structure() {
        let mut syntax = PythonSyntax::new();
        assert!(
            syntax
                .update("def axis(value: int):\n    return value\n")
                .is_empty()
        );
        assert_eq!(syntax.symbols()[0].name, "axis");
        assert!(syntax.structural_selection(4, 8).unwrap().end > 8);
        assert_eq!(syntax.matching_delimiter(8), Some(19));
        assert!(!syntax.update("def broken(\n").is_empty());
    }

    #[test]
    fn incremental_edits_update_tree_and_validate_utf8_ranges() {
        let mut syntax = PythonSyntax::new();
        syntax.update("value = (1 + 2)\n");
        let diagnostics = syntax
            .apply_edit(&TextEdit {
                start_byte: 14,
                old_end_byte: 15,
                replacement: String::new(),
            })
            .unwrap();
        assert!(!diagnostics.is_empty());
        assert_eq!(
            syntax.apply_edit(&TextEdit {
                start_byte: 99,
                old_end_byte: 99,
                replacement: String::new(),
            }),
            Err(EditError::InvalidRange)
        );
    }

    #[test]
    fn delimiter_matching_ignores_strings_and_comments() {
        let mut syntax = PythonSyntax::new();
        syntax.update("value = '('\nresult = (1 + 2)  # )\n");
        assert_eq!(syntax.matching_delimiter(9), None);
        let opening = syntax.source.find("(1").unwrap();
        assert_eq!(syntax.matching_delimiter(opening), Some(opening + 6));
        let comment = syntax.source.rfind(')').unwrap();
        assert_eq!(syntax.matching_delimiter(comment), None);
    }
}
