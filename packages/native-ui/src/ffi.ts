/**
 * Low-level Objective-C FFI via koffi.
 * 
 * This is the ugly part — isolated here so the rest can be clean.
 * Exports typed functions for ObjC message passing.
 */

import koffi from 'koffi';

// ============================================================================
// Types
// ============================================================================

/** Opaque pointer to ObjC object */
export type Id = unknown;

/** CGRect for frames */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** RGBA color */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

// ============================================================================
// Load Frameworks
// ============================================================================

const libobjc = koffi.load('/usr/lib/libobjc.A.dylib');
koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');

// Struct definitions
const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
const CGSize = koffi.struct('CGSize', { width: 'double', height: 'double' });
const CGRect = koffi.struct('CGRect', { origin: CGPoint, size: CGSize });
const NSEdgeInsets = koffi.struct('NSEdgeInsets', { 
  top: 'double', left: 'double', bottom: 'double', right: 'double' 
});

// Core runtime
const objc_getClass = libobjc.func('objc_getClass', 'void*', ['string']);
const sel_registerName = libobjc.func('sel_registerName', 'void*', ['string']);

// Message send variants
const msg0 = libobjc.func('objc_msgSend', 'void*', ['void*', 'void*']);
const msgB = libobjc.func('objc_msgSend', 'void', ['void*', 'void*', 'int8']);
const msgI = libobjc.func('objc_msgSend', 'void*', ['void*', 'void*', 'int64']);
const msgU = libobjc.func('objc_msgSend', 'void*', ['void*', 'void*', 'uint64']);
const msgD = libobjc.func('objc_msgSend', 'void*', ['void*', 'void*', 'double']);
const msgP = libobjc.func('objc_msgSend', 'void*', ['void*', 'void*', 'void*']);
const msgS = libobjc.func('objc_msgSend', 'void*', ['void*', 'void*', 'string']);
const msgR = libobjc.func('objc_msgSend', 'void', ['void*', 'void*', CGRect]);
const msgE = libobjc.func('objc_msgSend', 'void', ['void*', 'void*', NSEdgeInsets]);
const msg4D = libobjc.func('objc_msgSend', 'void*', ['void*', 'void*', 'double', 'double', 'double', 'double']);
const msgR3I = libobjc.func('objc_msgSend', 'void*', ['void*', 'void*', CGRect, 'uint64', 'uint64', 'int8']);

// Selector cache
const selCache = new Map<string, unknown>();

// ============================================================================
// Exports
// ============================================================================

export function sel(name: string): Id {
  let s = selCache.get(name);
  if (!s) {
    s = sel_registerName(name);
    selCache.set(name, s);
  }
  return s;
}

export function cls(name: string): Id {
  return objc_getClass(name);
}

export function alloc(className: string): Id {
  return msg0(cls(className), sel('alloc'));
}

export function init(obj: Id): Id {
  return msg0(obj, sel('init'));
}

export function call(obj: Id, selector: string): Id {
  return msg0(obj, sel(selector));
}

export function send(obj: Id, selector: string, arg: Id): Id {
  return msgP(obj, sel(selector), arg);
}

export function sendInt(obj: Id, selector: string, n: number): Id {
  return msgI(obj, sel(selector), n);
}

export function sendUInt(obj: Id, selector: string, n: number): Id {
  return msgU(obj, sel(selector), n);
}

export function sendDouble(obj: Id, selector: string, n: number): Id {
  return msgD(obj, sel(selector), n);
}

export function sendBool(obj: Id, selector: string, b: boolean): void {
  msgB(obj, sel(selector), b ? 1 : 0);
}

export function sendString(obj: Id, selector: string, s: string): Id {
  return msgS(obj, sel(selector), s);
}

export function sendRect(obj: Id, selector: string, r: Rect): void {
  msgR(obj, sel(selector), { origin: { x: r.x, y: r.y }, size: { width: r.width, height: r.height } });
}

export function sendInsets(obj: Id, selector: string, top: number, left: number, bottom: number, right: number): void {
  msgE(obj, sel(selector), { top, left, bottom, right });
}

// ============================================================================
// Convenience
// ============================================================================

export function nsString(s: string): Id {
  return sendString(cls('NSString'), 'stringWithUTF8String:', s);
}

export function nsColor(c: Color): Id {
  return msg4D(cls('NSColor'), sel('colorWithRed:green:blue:alpha:'), c.r, c.g, c.b, c.a);
}

export function nsFont(size: number, weight = 0.4): Id {
  return msg4D(cls('NSFont'), sel('systemFontOfSize:weight:'), size, weight, 0, 0);
}

export function nsFontMono(size: number, weight = 0.4): Id {
  return msg4D(cls('NSFont'), sel('monospacedSystemFontOfSize:weight:'), size, weight, 0, 0);
}

export function createWindow(title: string, rect: Rect): Id {
  const style = 1 | 2 | 4 | 8 | (1 << 15); // titled + closable + mini + resize + fullSizeContent
  const win = msgR3I(
    alloc('NSWindow'),
    sel('initWithContentRect:styleMask:backing:defer:'),
    { origin: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } },
    style, 2, 0
  );
  send(win, 'setTitle:', nsString(title));
  sendBool(win, 'setTitlebarAppearsTransparent:', true);
  sendUInt(win, 'setTitleVisibility:', 1);
  
  // Force light appearance
  const lightName = nsString('NSAppearanceNameAqua');
  const lightAppearance = send(cls('NSAppearance'), 'appearanceNamed:', lightName);
  send(win, 'setAppearance:', lightAppearance);
  
  return win;
}

export function runApp(): void {
  const app = call(cls('NSApplication'), 'sharedApplication');
  sendInt(app, 'setActivationPolicy:', 0);
  sendBool(app, 'activateIgnoringOtherApps:', true);
  call(app, 'run');
}

export function showWindow(win: Id, content: Id): void {
  send(win, 'setContentView:', content);
  sendBool(win, 'makeKeyAndOrderFront:', true);
}

// ============================================================================
// Constraints
// ============================================================================

// Layout attributes
export const Attr = {
  left: 1, right: 2, top: 3, bottom: 4,
  leading: 5, trailing: 6,
  width: 7, height: 8,
  centerX: 9, centerY: 10,
} as const;

const msg7 = libobjc.func('objc_msgSend', 'void*', [
  'void*', 'void*',  // target, selector
  'void*', 'int64', 'int64',  // item, attr, relation
  'void*', 'int64',  // toItem, toAttr
  'double', 'double'  // multiplier, constant
]);

export function constrain(
  view: Id, attr: number,
  toView: Id | null, toAttr: number,
  mult = 1, constant = 0
): Id {
  const constraint = msg7(
    cls('NSLayoutConstraint'),
    sel('constraintWithItem:attribute:relatedBy:toItem:attribute:multiplier:constant:'),
    view, attr, 0,  // relatedBy: 0 = equal
    toView, toAttr,
    mult, constant
  );
  sendBool(constraint, 'setActive:', true);
  return constraint;
}

export function pinToParent(view: Id, parent: Id, insets = { top: 0, left: 0, bottom: 0, right: 0 }): void {
  constrain(view, Attr.top, parent, Attr.top, 1, insets.top);
  constrain(view, Attr.bottom, parent, Attr.bottom, 1, -insets.bottom);
  constrain(view, Attr.leading, parent, Attr.leading, 1, insets.left);
  constrain(view, Attr.trailing, parent, Attr.trailing, 1, -insets.right);
}

export function setWidthConstraint(view: Id, width: number): void {
  constrain(view, Attr.width, null, 0, 1, width);
}

export function setHeightConstraint(view: Id, height: number): void {
  constrain(view, Attr.height, null, 0, 1, height);
}

// Stack view distribution
export const Distribution = {
  gravity: 0,       // cluster by gravity (default, bad)
  fill: 1,          // expand views to fill
  fillEqually: 2,
  fillProportional: 3,
  equalSpacing: 4,
  equalCentering: 5,
} as const;

// Hugging/compression priorities
export const Priority = {
  required: 1000,
  high: 750,
  low: 250,
  fittingSize: 50,
} as const;

// Priority is NSLayoutPriority which is a float, orientation is NSLayoutConstraintOrientation (int)
const msgFI = libobjc.func('objc_msgSend', 'void', ['void*', 'void*', 'float', 'int64']);

export function setHuggingPriority(view: Id, priority: number, orientation: number): void {
  msgFI(view, sel('setContentHuggingPriority:forOrientation:'), priority, orientation);
}

export function setCompressionResistance(view: Id, priority: number, orientation: number): void {
  msgFI(view, sel('setContentCompressionResistancePriority:forOrientation:'), priority, orientation);
}

// For NSSplitView
const msgDI = libobjc.func('objc_msgSend', 'void', ['void*', 'void*', 'double', 'int64']);

export function setSplitPosition(split: Id, position: number, dividerIndex: number): void {
  msgDI(split, sel('setPosition:ofDividerAt:'), position, dividerIndex);
}

// ============================================================================
// Callbacks / Actions
// ============================================================================

// Define callback type for button actions: void action(id sender)
const ActionCallback = koffi.proto('void ActionCallback(void *sender)');

// Store registered callbacks to prevent GC and allow cleanup
const registeredCallbacks = new Map<number, unknown>();
let callbackId = 0;

/**
 * Create a target object that invokes a JS callback when its action is triggered.
 * Returns { target, action, id } - use id to unregister later.
 */
export function createAction(callback: (sender: Id) => void): { target: Id; action: Id; id: number } {
  // Create a simple NSObject subclass instance to be the target
  // We'll use a custom class that stores the callback
  
  // For simplicity, we'll create an NSObject and use associated objects
  // But actually, the easiest approach is to use a block-based action
  
  // NSButton doesn't directly support block actions, but we can create
  // a helper class. For now, let's use a simpler approach:
  // Create an ActionTarget class dynamically
  
  const id = callbackId++;
  
  // Register the callback with koffi
  const registered = koffi.register(callback, koffi.pointer(ActionCallback));
  registeredCallbacks.set(id, registered);
  
  // Create a proxy target - for now we'll use the callback directly
  // This is a simplification - proper impl would need an ObjC class
  
  // Actually, let's just store the callback and have a polling mechanism
  // or use NSControl's sendAction mechanism differently
  
  // For MVP: return the registered callback as target, action is a placeholder
  return { 
    target: registered as Id, 
    action: sel('invoke'), // placeholder - needs proper implementation
    id 
  };
}

export function unregisterAction(id: number): void {
  const registered = registeredCallbacks.get(id);
  if (registered) {
    koffi.unregister(registered);
    registeredCallbacks.delete(id);
  }
}
