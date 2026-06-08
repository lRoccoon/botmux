#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface BotmuxDesktopPetPanel : NSPanel
@end

@implementation BotmuxDesktopPetPanel
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
@end

@interface BotmuxDesktopPetWindow : NSObject <WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property (nonatomic, strong) BotmuxDesktopPetPanel *panel;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, copy) NSString *cookieName;
@property (nonatomic, copy) NSString *cookieValue;
@property (nonatomic, copy) NSString *loadedURL;
@property (nonatomic, copy) NSString *petOrigin;
@property (nonatomic, assign) CGFloat width;
@property (nonatomic, assign) CGFloat height;
@property (nonatomic, assign) NSPoint dragStartOrigin;
@end

@implementation BotmuxDesktopPetWindow

- (instancetype)init {
    self = [super init];
    if (self != nil) {
        self.width = 220.0;
        self.height = 220.0;
    }
    return self;
}

- (void)ensureApplicationCanPresentUI {
    [NSApplication sharedApplication];
    if (NSApp.activationPolicy == NSApplicationActivationPolicyProhibited) {
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    }
}

- (void)setupIfNeeded {
    if (self.panel != nil) return;

    [self ensureApplicationCanPresentUI];

    NSRect frame = NSMakeRect(0, 0, self.width, self.height);
    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    config.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    WKUserContentController *userContent = [[WKUserContentController alloc] init];
    [userContent addScriptMessageHandler:self name:@"botmuxPetAction"];
    config.userContentController = userContent;

    WKWebView *web = [[WKWebView alloc] initWithFrame:frame configuration:config];
    web.translatesAutoresizingMaskIntoConstraints = YES;
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    web.navigationDelegate = self;
    web.UIDelegate = self;
    web.wantsLayer = YES;
    web.layer.backgroundColor = [NSColor clearColor].CGColor;
    web.layer.opaque = NO;
    web.enclosingScrollView.drawsBackground = NO;
    @try {
        [web setValue:@NO forKey:@"drawsBackground"];
    } @catch (__unused NSException *exception) {
    }

    NSWindowStyleMask mask = NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel;
    BotmuxDesktopPetPanel *panel = [[BotmuxDesktopPetPanel alloc]
        initWithContentRect:frame
                  styleMask:mask
                    backing:NSBackingStoreBuffered
                      defer:YES];
    panel.floatingPanel = YES;
    panel.becomesKeyOnlyIfNeeded = YES;
    panel.hidesOnDeactivate = NO;
    panel.releasedWhenClosed = NO;
    panel.opaque = NO;
    panel.backgroundColor = [NSColor clearColor];
    panel.hasShadow = NO;
    panel.level = NSFloatingWindowLevel;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces
        | NSWindowCollectionBehaviorFullScreenAuxiliary;
    panel.contentView = web;

    self.panel = panel;
    self.webView = web;
}

- (NSString *)originForURL:(NSURL *)url {
    if (url == nil || url.scheme.length == 0 || url.host.length == 0) return nil;
    NSString *scheme = [url.scheme lowercaseString];
    NSString *host = [url.host lowercaseString];
    NSNumber *port = url.port;
    NSString *portPart = port != nil ? [NSString stringWithFormat:@":%@", port] : @"";
    return [NSString stringWithFormat:@"%@://%@%@", scheme, host, portPart];
}

- (BOOL)isTrustedPetURL:(NSURL *)url {
    if (url == nil) return NO;
    NSString *scheme = [url.scheme lowercaseString];
    if ([scheme isEqualToString:@"about"]) return YES;
    NSString *origin = [self originForURL:url];
    return origin.length > 0 && self.petOrigin.length > 0 && [origin isEqualToString:self.petOrigin];
}

- (BOOL)isLoopbackHostURL:(NSURL *)url {
    if (url == nil) return NO;
    NSString *host = [url.host lowercaseString];
    return [host isEqualToString:@"127.0.0.1"] || [host isEqualToString:@"localhost"] || [host isEqualToString:@"::1"];
}

- (void)positionInitialFrame {
    if (self.panel.isVisible) return;
    NSScreen *screen = [NSScreen mainScreen];
    if (screen == nil) return;
    NSRect visible = screen.visibleFrame;
    CGFloat x = NSMaxX(visible) - self.width - 36.0;
    CGFloat y = NSMinY(visible) + 52.0;
    [self.panel setFrame:NSMakeRect(round(x), round(y), self.width, self.height) display:YES];
}

- (NSRect)clampedFrameForOrigin:(NSPoint)origin {
    NSScreen *screen = nil;
    NSRect proposed = NSMakeRect(origin.x, origin.y, self.width, self.height);
    NSPoint center = NSMakePoint(NSMidX(proposed), NSMidY(proposed));
    for (NSScreen *s in [NSScreen screens]) {
        if (NSPointInRect(center, s.frame)) { screen = s; break; }
    }
    if (screen == nil) screen = [NSScreen mainScreen];
    if (screen == nil) return proposed;
    NSRect visible = screen.visibleFrame;
    CGFloat minX = NSMinX(visible) - self.width * 0.35;
    CGFloat maxX = NSMaxX(visible) - self.width * 0.65;
    CGFloat minY = NSMinY(visible);
    CGFloat maxY = NSMaxY(visible) - self.height;
    CGFloat x = MIN(MAX(origin.x, minX), maxX < minX ? minX : maxX);
    CGFloat y = MIN(MAX(origin.y, minY), maxY < minY ? minY : maxY);
    return NSMakeRect(round(x), round(y), self.width, self.height);
}

- (void)loadAndShow:(NSString *)url {
    NSURL *u = [NSURL URLWithString:url];
    if (u == nil) return;
    [self setupIfNeeded];
    self.petOrigin = [self originForURL:u];
    if (![self.loadedURL isEqualToString:url]) {
        NSURLRequest *request = [NSURLRequest requestWithURL:u
                                                 cachePolicy:NSURLRequestUseProtocolCachePolicy
                                             timeoutInterval:8.0];
        self.loadedURL = [url copy];
        [self.webView loadRequest:request];
    }
    [self positionInitialFrame];
    [self.panel orderFrontRegardless];
    [self.panel makeKeyWindow];
}

- (void)showURL:(NSString *)url cookieName:(NSString *)cookieName cookieValue:(NSString *)cookieValue {
    if (NSClassFromString(@"WKWebView") == nil) return;
    [self setupIfNeeded];
    self.cookieName = cookieName ? [cookieName copy] : @"";
    self.cookieValue = cookieValue ? [cookieValue copy] : @"";
    if (self.cookieName.length > 0 && self.cookieValue.length > 0) {
        NSDictionary *props = @{
            NSHTTPCookieName: self.cookieName,
            NSHTTPCookieValue: self.cookieValue,
            NSHTTPCookieDomain: @"127.0.0.1",
            NSHTTPCookiePath: @"/",
            NSHTTPCookieDiscard: @YES,
        };
        NSHTTPCookie *cookie = [NSHTTPCookie cookieWithProperties:props];
        if (cookie != nil) {
            __weak typeof(self) weakSelf = self;
            [self.webView.configuration.websiteDataStore.httpCookieStore setCookie:cookie completionHandler:^{
                __strong typeof(weakSelf) self_ = weakSelf;
                if (self_ == nil) return;
                dispatch_async(dispatch_get_main_queue(), ^{
                    [self_ loadAndShow:url];
                });
            }];
            return;
        }
    }
    [self loadAndShow:url];
}

- (void)closeAndStop {
    if (self.panel != nil) [self.panel orderOut:nil];
    [NSApp stop:nil];
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                        location:NSZeroPoint
                                   modifierFlags:0
                                       timestamp:0
                                    windowNumber:0
                                         context:nil
                                         subtype:0
                                           data1:0
                                           data2:0];
    [NSApp postEvent:event atStart:YES];
}

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;
    if ([self isTrustedPetURL:url]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if ([self isLoopbackHostURL:url]) {
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    if (url != nil) [[NSWorkspace sharedWorkspace] openURL:url];
    decisionHandler(WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
    NSURL *url = navigationAction.request.URL;
    if ([self isLoopbackHostURL:url]) return nil;
    if (url != nil) [[NSWorkspace sharedWorkspace] openURL:url];
    return nil;
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.name isEqualToString:@"botmuxPetAction"]) return;
    if (![message.body isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *body = (NSDictionary *)message.body;
    NSString *action = [body objectForKey:@"action"];
    if (![action isKindOfClass:[NSString class]]) return;

    if ([action isEqualToString:@"quit"]) {
        [self closeAndStop];
        return;
    }
    if ([action isEqualToString:@"drag_start"]) {
        self.dragStartOrigin = self.panel.frame.origin;
        return;
    }
    if ([action isEqualToString:@"drag_move"]) {
        id dxValue = [body objectForKey:@"dx"];
        id dyValue = [body objectForKey:@"dy"];
        if (![dxValue respondsToSelector:@selector(doubleValue)] || ![dyValue respondsToSelector:@selector(doubleValue)]) return;
        CGFloat dx = [dxValue doubleValue];
        CGFloat dy = [dyValue doubleValue];
        NSPoint next = NSMakePoint(self.dragStartOrigin.x + dx, self.dragStartOrigin.y - dy);
        [self.panel setFrame:[self clampedFrameForOrigin:next] display:NO];
        return;
    }
    if ([action isEqualToString:@"drag_end"]) {
        [self.panel displayIfNeeded];
        return;
    }
}

@end

static NSString *ArgValue(int argc, const char *argv[], const char *name) {
    for (int i = 1; i + 1 < argc; i++) {
        if (strcmp(argv[i], name) == 0) {
            return [NSString stringWithUTF8String:argv[i + 1]];
        }
    }
    return @"";
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *url = ArgValue(argc, argv, "--url");
        NSString *cookieName = ArgValue(argc, argv, "--cookie-name");
        NSString *cookieValue = ArgValue(argc, argv, "--cookie-value");
        if (url.length == 0 || NSClassFromString(@"WKWebView") == nil) return 1;
        [NSApplication sharedApplication];
        BotmuxDesktopPetWindow *window = [[BotmuxDesktopPetWindow alloc] init];
        [window showURL:url cookieName:cookieName cookieValue:cookieValue];
        [NSApp run];
    }
    return 0;
}
