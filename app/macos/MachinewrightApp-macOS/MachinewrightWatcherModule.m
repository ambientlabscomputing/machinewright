#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <CoreServices/CoreServices.h>

/// Watches the open project's directory tree (FSEvents) so the file explorer
/// and quick-open index stay current when files change outside the app — a
/// shell command in the terminal, git, another editor. Emits
/// `MachinewrightFsChange` with root-relative paths of everything that
/// changed (coalesced over ~250 ms). Filtering of noisy directories (.git,
/// .venv, …) is the JS side's job; this module reports faithfully.
@interface MachinewrightWatcherModule : RCTEventEmitter <RCTBridgeModule>
@end

@implementation MachinewrightWatcherModule {
  FSEventStreamRef _stream;
  NSString *_root;
  BOOL _hasListeners;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup { return NO; }
- (NSArray<NSString *> *)supportedEvents { return @[ @"MachinewrightFsChange" ]; }
- (void)startObserving { _hasListeners = YES; }
- (void)stopObserving { _hasListeners = NO; }

- (void)invalidate {
  [self stopStream];
  [super invalidate];
}

- (void)stopStream {
  @synchronized(self) {
    if (_stream) {
      FSEventStreamStop(_stream);
      FSEventStreamInvalidate(_stream);
      FSEventStreamRelease(_stream);
      _stream = NULL;
    }
    _root = nil;
  }
}

- (void)handlePaths:(NSArray<NSString *> *)paths {
  NSString *root;
  @synchronized(self) { root = _root; }
  NSLog(@"[watcher] %lu raw paths, root=%@ listeners=%d", (unsigned long)paths.count, root, _hasListeners);
  if (!root || !_hasListeners) return;
  NSString *prefix = [root stringByAppendingString:@"/"];
  NSMutableOrderedSet<NSString *> *relative = [NSMutableOrderedSet orderedSet];
  for (NSString *path in paths) {
    if ([path hasPrefix:prefix]) [relative addObject:[path substringFromIndex:prefix.length]];
    if (relative.count >= 500) break;
  }
  if (relative.count == 0) return;
  [self sendEventWithName:@"MachinewrightFsChange" body:@{ @"paths" : relative.array }];
}

static void MWWatcherCallback(ConstFSEventStreamRef stream, void *info, size_t count, void *paths,
                              const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
  MachinewrightWatcherModule *module = (__bridge MachinewrightWatcherModule *)info;
  [module handlePaths:(__bridge NSArray<NSString *> *)paths];
}

/// Starts watching `root`, replacing any previous watch.
RCT_EXPORT_METHOD(watch:(NSString *)root) {
  [self stopStream];
  // FSEvents reports resolved paths, so resolve symlinks (/tmp -> /private/tmp) up front.
  // (NSString's resolver leaves /tmp unresolved while FSEvents reports /private/tmp; realpath is exact.)
  char buffer[PATH_MAX];
  NSString *resolved = realpath(root.fileSystemRepresentation, buffer) ? @(buffer) : root;
  NSLog(@"[watcher] watch %@ (resolved %@)", root, resolved);
  FSEventStreamContext context = {0, (__bridge void *)self, NULL, NULL, NULL};
  FSEventStreamRef stream = FSEventStreamCreate(
      NULL, MWWatcherCallback, &context, (__bridge CFArrayRef) @[ resolved ], kFSEventStreamEventIdSinceNow, 0.25,
      kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer);
  if (!stream) return;
  @synchronized(self) {
    _root = resolved;
    _stream = stream;
  }
  FSEventStreamSetDispatchQueue(stream, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  FSEventStreamStart(stream);
}

RCT_EXPORT_METHOD(unwatch) { [self stopStream]; }

@end
