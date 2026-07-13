import AppKit
import CoreGraphics
import Foundation

let iconDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let projectRoot = iconDir.deletingLastPathComponent().deletingLastPathComponent()

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(
        calibratedRed: CGFloat((hex >> 16) & 0xff) / 255,
        green: CGFloat((hex >> 8) & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255,
        alpha: alpha
    )
}

func roundedRect(_ rect: CGRect, radius: CGFloat) -> NSBezierPath {
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
}

func strokeLine(from start: CGPoint, to end: CGPoint, width: CGFloat, color: NSColor, cap: CGLineCap = .round) {
    guard let context = NSGraphicsContext.current?.cgContext else { return }
    context.saveGState()
    context.setStrokeColor(color.cgColor)
    context.setLineWidth(width)
    context.setLineCap(cap)
    context.move(to: start)
    context.addLine(to: end)
    context.strokePath()
    context.restoreGState()
}

func drawIcon(size: Int) -> NSImage {
    let scale = CGFloat(size) / 1024
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    guard let context = NSGraphicsContext.current?.cgContext else {
        image.unlockFocus()
        return image
    }
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    context.interpolationQuality = .high

    let bounds = CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size))
    color(0x000000, 0).setFill()
    bounds.fill()

    let base = bounds.insetBy(dx: 56 * scale, dy: 56 * scale)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -26 * scale), blur: 52 * scale, color: color(0x1c1917, 0.28).cgColor)
    color(0xfffaf3).setFill()
    roundedRect(base, radius: 232 * scale).fill()
    context.restoreGState()

    let body = base.insetBy(dx: 30 * scale, dy: 30 * scale)
    let gradient = NSGradient(colors: [color(0x2a6b58), color(0x173f35)])!
    gradient.draw(in: roundedRect(body, radius: 204 * scale), angle: -35)

    let inner = body.insetBy(dx: 86 * scale, dy: 118 * scale)
    let panelGap = 28 * scale
    let panelWidth = (inner.width - panelGap * 2) / 3
    let panelHeight = inner.height
    let panelY = inner.minY
    let panels = (0..<3).map { index in
        CGRect(
            x: inner.minX + CGFloat(index) * (panelWidth + panelGap),
            y: panelY,
            width: panelWidth,
            height: panelHeight
        )
    }

    for (index, panel) in panels.enumerated() {
        let path = roundedRect(panel, radius: 36 * scale)
        color(index == 1 ? 0xf7f3ec : 0xefe8dc, index == 1 ? 0.98 : 0.92).setFill()
        path.fill()
        color(0x0f2f28, 0.2).setStroke()
        path.lineWidth = 5 * scale
        path.stroke()
    }

    let lineColors = [color(0x9b2c2c), color(0x245c4a), color(0xbd7d2f)]
    for (panelIndex, panel) in panels.enumerated() {
        let left = panel.minX + 26 * scale
        let right = panel.maxX - 26 * scale
        for row in 0..<5 {
            let y = panel.maxY - (58 + CGFloat(row) * 56) * scale
            let inset = CGFloat((row + panelIndex) % 2) * 18 * scale
            let widthColor = row == 1 && panelIndex != 1 ? lineColors[0] : (row == 3 ? lineColors[1] : color(0x6b6358, 0.72))
            strokeLine(
                from: CGPoint(x: left + inset, y: y),
                to: CGPoint(x: right - inset, y: y),
                width: 15 * scale,
                color: widthColor
            )
        }
    }

    let center = panels[1]
    strokeLine(
        from: CGPoint(x: panels[0].maxX - 2 * scale, y: panels[0].midY + 88 * scale),
        to: CGPoint(x: center.midX, y: center.midY + 24 * scale),
        width: 24 * scale,
        color: color(0xe9d8a6),
        cap: .round
    )
    strokeLine(
        from: CGPoint(x: panels[2].minX + 2 * scale, y: panels[2].midY - 88 * scale),
        to: CGPoint(x: center.midX, y: center.midY + 24 * scale),
        width: 24 * scale,
        color: color(0xe9d8a6),
        cap: .round
    )
    strokeLine(
        from: CGPoint(x: center.midX, y: center.midY + 20 * scale),
        to: CGPoint(x: center.midX, y: center.midY - 112 * scale),
        width: 24 * scale,
        color: color(0xe9d8a6),
        cap: .round
    )

    let badge = CGRect(x: center.midX - 88 * scale, y: center.midY - 204 * scale, width: 176 * scale, height: 176 * scale)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -10 * scale), blur: 18 * scale, color: color(0x0f2f28, 0.35).cgColor)
    color(0x2f7d5e).setFill()
    NSBezierPath(ovalIn: badge).fill()
    context.restoreGState()

    strokeLine(
        from: CGPoint(x: badge.minX + 45 * scale, y: badge.midY + 2 * scale),
        to: CGPoint(x: badge.midX - 6 * scale, y: badge.minY + 52 * scale),
        width: 26 * scale,
        color: color(0xfffaf3)
    )
    strokeLine(
        from: CGPoint(x: badge.midX - 6 * scale, y: badge.minY + 52 * scale),
        to: CGPoint(x: badge.maxX - 42 * scale, y: badge.maxY - 48 * scale),
        width: 26 * scale,
        color: color(0xfffaf3)
    )

    image.unlockFocus()
    return image
}

func pngData(for image: NSImage) -> Data {
    guard
        let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let data = bitmap.representation(using: .png, properties: [:])
    else {
        fatalError("Could not create PNG data")
    }
    return data
}

func writePNG(_ size: Int, to url: URL) {
    let data = pngData(for: drawIcon(size: size))
    try! data.write(to: url)
}

let sourceIcon = iconDir.appendingPathComponent("icon.png")
writePNG(1024, to: sourceIcon)

let process = Process()
process.currentDirectoryURL = projectRoot
process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
process.arguments = ["npm", "run", "tauri", "--", "icon", "src-tauri/icons/icon.png"]
try! process.run()
process.waitUntilExit()

if process.terminationStatus != 0 {
    fatalError("Tauri icon generation failed with status \(process.terminationStatus)")
}

print("Generated mergev app icons in \(iconDir.path)")
