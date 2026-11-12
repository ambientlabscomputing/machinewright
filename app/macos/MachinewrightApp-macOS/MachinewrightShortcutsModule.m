#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

/// Application-wide keyboard shortcuts (command palette, quick open, …).
///
/// Shortcuts have to work no matter which surface owns focus — the
/// CodeMirror and terminal WKWebViews swallow key events before React Native
/// ever sees them — so this installs an `NSEvent` local monitor, which runs
/// before the key window's responder chain. JS declares which chords it
/// wants via `setChords`; matching events are consumed and re-emitted as a
/// `MachinewrightShortcut` event whose body is the canonical chord string
/// (see src/commands/chords.ts: modifiers in the order Cmd, Ctrl, Alt,
/// Shift, then the key). Everything else flows through untouched.
///
/// It also owns the one piece of focus plumbing the shell needs: telling
/// which WKWebView surface (editor, terminal) holds keyboard focus and
/// handing focus to one, since script-level `element.focus()` inside a
/// WKWebView does not make the web view the window's first responder.
@interface MachinewrightShortcutsModule : RCTEventEmitter <RCTBridgeModule>
@end

@implementation MachinewrightShortcutsModule {
  NSSet<NSString *> *_chords;
  id _monitor;
  BOOL _hasListeners;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup { return YES; }

- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (NSArray<NSString *> *)supportedEvents { return @[ @"MachinewrightShortcut" ]; }

- (void)startObserving { _hasListeners = YES; }
- (void)stopObserving { _hasListeners = NO; }

- (void)invalidate {
  if (_monitor) {
    [NSEvent removeMonitor:_monitor];
    _monitor = nil;
  }
  [super invalidate];
}

+ (nullable NSString *)keyNameForEvent:(NSEvent *)event {
  switch (event.keyCode) {
    case 53: return @"Escape";
    case 36: case 76: return @"Enter";
    case 48: return @"Tab";
    case 49: return @"Space";
    case 126: return @"Up";
    case 125: return @"Down";
    case 123: return @"Left";
    case 124: return @"Right";
    default: break;
  }
  NSString *characters = event.charactersIgnoringModifiers;
  if (characters.length == 0) return nil;
  return characters.uppercaseString;
}

+ (nullable NSString *)chordForEvent:(NSEvent *)event {
  NSString *key = [self keyNameForEvent:event];
  if (!key) return nil;
  NSEventModifierFlags flags = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
  NSMutableArray<NSString *> *parts = [NSMutableArray array];
  if (flags & NSEventModifierFlagCommand) [parts addObject:@"Cmd"];
  if (flags & NSEventModifierFlagControl) [parts addObject:@"Ctrl"];
  if (flags & NSEventModifierFlagOption) [parts addObject:@"Alt"];
  if (flags & NSEventModifierFlagShift) [parts addObject:@"Shift"];
  [parts addObject:key];
  return [parts componentsJoinedByString:@"+"];
}

RCT_EXPORT_METHOD(setChords:(NSArray<NSString *> *)chords) {
  _chords = [NSSet setWithArray:chords ?: @[]];
  if (_monitor) return;
  __weak MachinewrightShortcutsModule *weakSelf = self;
  _monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                   handler:^NSEvent *(NSEvent *event) {
    MachinewrightShortcutsModule *strongSelf = weakSelf;
    if (!strongSelf || strongSelf->_chords.count == 0) return event;
    // Leave modal panels (NSOpenPanel etc.) alone: their keys are theirs.
    if (NSApp.modalWindow) return event;
    NSString *chord = [MachinewrightShortcutsModule chordForEvent:event];
    if (!chord || ![strongSelf->_chords containsObject:chord]) return event;
    // Consume repeats too, so holding Cmd+P cannot leak keystrokes into a field.
    if (!event.isARepeat && strongSelf->_hasListeners) {
      [strongSelf sendEventWithName:@"MachinewrightShortcut" body:@{ @"chord" : chord }];
    }
    return nil;
  }];
}

static WKWebView *MWFindWebView(NSView *root, NSString *fragment) {
  if ([root isKindOfClass:WKWebView.class]) {
    WKWebView *candidate = (WKWebView *)root;
    if ([candidate.URL.absoluteString containsString:fragment]) return candidate;
  }
  for (NSView *child in root.subviews) {
    WKWebView *found = MWFindWebView(child, fragment);
    if (found) return found;
  }
  return nil;
}

/// Gives keyboard focus to the WKWebView whose URL contains `fragment`
/// (e.g. "web/terminal"); resolves whether one was found.
RCT_EXPORT_METHOD(focusSurface:(NSString *)fragment
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSWindow *window = NSApp.keyWindow ?: NSApp.mainWindow ?: NSApp.windows.firstObject;
  WKWebView *webView = window ? MWFindWebView(window.contentView, fragment) : nil;
  if (webView) [window makeFirstResponder:webView];
  resolve(@(webView != nil));
}

/// The URL of the WKWebView that currently holds keyboard focus, or null
/// when focus is in a native/React Native view.
RCT_EXPORT_METHOD(focusedSurface:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSWindow *window = NSApp.keyWindow ?: NSApp.mainWindow;
  NSResponder *responder = window.firstResponder;
  while (responder) {
    if ([responder isKindOfClass:WKWebView.class]) {
      resolve(((WKWebView *)responder).URL.absoluteString ?: [NSNull null]);
      return;
    }
    responder = [responder isKindOfClass:NSView.class] ? ((NSView *)responder).superview : responder.nextResponder;
  }
  resolve([NSNull null]);
}

@end
