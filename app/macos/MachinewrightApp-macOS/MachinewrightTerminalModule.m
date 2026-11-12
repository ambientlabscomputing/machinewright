#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <Foundation/Foundation.h>
#import <util.h>
#import <sys/ioctl.h>
#import <sys/wait.h>
#import <signal.h>
#import <unistd.h>

/// Pseudo-terminal sessions for the in-window terminal (Cmd+J).
///
/// Owns only the process and its pty: `forkpty` gives the shell a real
/// controlling terminal (job control, Ctrl-C, full-screen programs). Terminal
/// emulation itself lives in the bundled xterm.js surface (web/terminal);
/// this module just moves bytes. Output is base64 on the wire because a read
/// can end mid UTF-8 sequence — xterm.js decodes the reassembled byte stream.
@interface MachinewrightTerminalSession : NSObject
@property(nonatomic) int fd;
@property(nonatomic) pid_t pid;
@property(nonatomic, strong) dispatch_source_t readSource;
@end
@implementation MachinewrightTerminalSession
@end

@interface MachinewrightTerminalModule : RCTEventEmitter <RCTBridgeModule>
@end

@implementation MachinewrightTerminalModule {
  NSMutableDictionary<NSNumber *, MachinewrightTerminalSession *> *_sessions;
  NSInteger _nextId;
  BOOL _hasListeners;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"MachinewrightTerminalData", @"MachinewrightTerminalExit" ];
}

- (void)startObserving { _hasListeners = YES; }
- (void)stopObserving { _hasListeners = NO; }

- (instancetype)init {
  if ((self = [super init])) {
    _sessions = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)invalidate {
  NSArray<MachinewrightTerminalSession *> *sessions;
  @synchronized(self) {
    sessions = _sessions.allValues;
    [_sessions removeAllObjects];
  }
  for (MachinewrightTerminalSession *session in sessions) {
    kill(session.pid, SIGHUP);
    if (session.readSource) dispatch_source_cancel(session.readSource);
  }
  [super invalidate];
}

static char **MWCopyStringArray(NSArray<NSString *> *strings) {
  char **array = calloc(strings.count + 1, sizeof(char *));
  for (NSUInteger i = 0; i < strings.count; i++) array[i] = strdup(strings[i].UTF8String);
  return array;
}

static void MWFreeStringArray(char **array) {
  for (char **p = array; *p; p++) free(*p);
  free(array);
}

RCT_EXPORT_METHOD(start:(NSString *)cwd
                  cols:(nonnull NSNumber *)cols
                  rows:(nonnull NSNumber *)rows
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSDictionary<NSString *, NSString *> *inherited = NSProcessInfo.processInfo.environment;
  NSString *shell = inherited[@"SHELL"].length ? inherited[@"SHELL"] : @"/bin/zsh";
  NSMutableDictionary<NSString *, NSString *> *environment = [inherited mutableCopy];
  environment[@"TERM"] = @"xterm-256color";
  environment[@"COLORTERM"] = @"truecolor";
  environment[@"TERM_PROGRAM"] = @"Machinewright";
  // GUI-launched apps usually have no locale; without one zsh mangles UTF-8.
  if (!environment[@"LANG"]) environment[@"LANG"] = @"en_US.UTF-8";
  NSMutableArray<NSString *> *envStrings = [NSMutableArray array];
  [environment enumerateKeysAndObjectsUsingBlock:^(NSString *key, NSString *value, BOOL *stop) {
    [envStrings addObject:[NSString stringWithFormat:@"%@=%@", key, value]];
  }];

  // Everything the child touches between fork and exec is prepared up front
  // (only async-signal-safe calls are allowed in between).
  char *shellPath = strdup(shell.UTF8String);
  char *workingDirectory = strdup(cwd.length ? cwd.UTF8String : NSHomeDirectory().UTF8String);
  char **argv = MWCopyStringArray(@[ shell, @"-l" ]);
  char **envp = MWCopyStringArray(envStrings);
  struct winsize size = {.ws_row = rows.unsignedShortValue, .ws_col = cols.unsignedShortValue};

  int master = -1;
  pid_t pid = forkpty(&master, NULL, NULL, &size);
  if (pid == 0) {
    chdir(workingDirectory);
    execve(shellPath, argv, envp);
    _exit(127);
  }
  int forkError = errno;
  free(shellPath);
  free(workingDirectory);
  MWFreeStringArray(argv);
  MWFreeStringArray(envp);
  if (pid < 0) {
    reject(@"terminal_spawn_failed",
           [NSString stringWithFormat:@"forkpty failed: %s", strerror(forkError)], nil);
    return;
  }

  MachinewrightTerminalSession *session = [MachinewrightTerminalSession new];
  session.fd = master;
  session.pid = pid;
  NSNumber *sessionId;
  @synchronized(self) {
    sessionId = @(++_nextId);
    _sessions[sessionId] = session;
  }

  dispatch_source_t source =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, master, 0,
                             dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0));
  session.readSource = source;
  __weak MachinewrightTerminalModule *weakSelf = self;
  dispatch_source_set_event_handler(source, ^{
    uint8_t buffer[65536];
    ssize_t count = read(master, buffer, sizeof buffer);
    if (count > 0) {
      MachinewrightTerminalModule *strongSelf = weakSelf;
      if (strongSelf && strongSelf->_hasListeners) {
        NSString *encoded = [[NSData dataWithBytes:buffer length:(NSUInteger)count] base64EncodedStringWithOptions:0];
        [strongSelf sendEventWithName:@"MachinewrightTerminalData" body:@{ @"id" : sessionId, @"data" : encoded }];
      }
    } else if (count == 0 || (count < 0 && errno != EINTR && errno != EAGAIN)) {
      // EOF/EIO: the slave side closed, i.e. the shell is gone.
      dispatch_source_cancel(source);
    }
  });
  dispatch_source_set_cancel_handler(source, ^{
    close(master);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      int status = 0;
      waitpid(pid, &status, 0);
      int code = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
      MachinewrightTerminalModule *strongSelf = weakSelf;
      if (!strongSelf) return;
      @synchronized(strongSelf) {
        [strongSelf->_sessions removeObjectForKey:sessionId];
      }
      if (strongSelf->_hasListeners) {
        [strongSelf sendEventWithName:@"MachinewrightTerminalExit" body:@{ @"id" : sessionId, @"code" : @(code) }];
      }
    });
  });
  dispatch_resume(source);
  resolve(sessionId);
}

- (MachinewrightTerminalSession *)sessionForId:(NSNumber *)sessionId {
  @synchronized(self) { return _sessions[sessionId]; }
}

RCT_EXPORT_METHOD(write:(nonnull NSNumber *)sessionId data:(NSString *)data) {
  MachinewrightTerminalSession *session = [self sessionForId:sessionId];
  if (!session) return;
  NSData *bytes = [data dataUsingEncoding:NSUTF8StringEncoding];
  const uint8_t *cursor = bytes.bytes;
  size_t remaining = bytes.length;
  while (remaining > 0) {
    ssize_t written = write(session.fd, cursor, remaining);
    if (written < 0) {
      if (errno == EINTR || errno == EAGAIN) continue;
      return;
    }
    cursor += written;
    remaining -= (size_t)written;
  }
}

RCT_EXPORT_METHOD(resize:(nonnull NSNumber *)sessionId
                  cols:(nonnull NSNumber *)cols
                  rows:(nonnull NSNumber *)rows) {
  MachinewrightTerminalSession *session = [self sessionForId:sessionId];
  if (!session) return;
  struct winsize size = {.ws_row = rows.unsignedShortValue, .ws_col = cols.unsignedShortValue};
  ioctl(session.fd, TIOCSWINSZ, &size);
}

RCT_EXPORT_METHOD(kill:(nonnull NSNumber *)sessionId) {
  MachinewrightTerminalSession *session = [self sessionForId:sessionId];
  if (!session) return;
  kill(session.pid, SIGHUP);
}

@end
