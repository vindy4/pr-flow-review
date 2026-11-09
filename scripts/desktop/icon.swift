import AppKit
let output = CommandLine.arguments[1]
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill(); NSRect(x: 0,y: 0,width: size,height: size).fill()
NSColor(calibratedRed: 0.045,green: 0.085,blue: 0.16,alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 52,y: 52,width: 920,height: 920),xRadius: 205,yRadius: 205).fill()
let cyan = NSColor(calibratedRed: 0.36,green: 0.89,blue: 0.93,alpha: 1)
cyan.setStroke(); cyan.setFill()
let line = NSBezierPath(); line.lineWidth = 46; line.lineCapStyle = .round
line.move(to: NSPoint(x: 365,y: 300));line.line(to: NSPoint(x: 365,y: 730))
line.move(to: NSPoint(x: 365,y: 460));line.curve(to: NSPoint(x: 665,y: 700),controlPoint1: NSPoint(x: 660,y: 460),controlPoint2: NSPoint(x: 665,y: 550));line.stroke()
for point in [NSPoint(x: 365,y: 300),NSPoint(x: 365,y: 730),NSPoint(x: 665,y: 730)] {
  NSBezierPath(ovalIn: NSRect(x: point.x-66,y: point.y-66,width: 132,height: 132)).fill()
  NSColor(calibratedRed: 0.045,green: 0.085,blue: 0.16,alpha: 1).setFill()
  NSBezierPath(ovalIn: NSRect(x: point.x-27,y: point.y-27,width: 54,height: 54)).fill();cyan.setFill()
}
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
