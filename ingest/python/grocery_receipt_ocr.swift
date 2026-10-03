// Apple Vision OCR for receipt photos — text blocks with geometry, as JSON on stdout.
//
//   grocery_receipt_ocr <image>   →  {"engine","width","height","blocks":[{text,conf,x,y,w,h,tl,tr,bl,br}]}
//
// Coordinates are Vision's: normalised to the UPRIGHT image (EXIF orientation applied here via
// CoreImage, so a phone photo never arrives sideways), origin bottom-left. `x,y,w,h` is the
// axis-aligned box; `tl/tr/bl/br` are the recognised quad's corners, from which the Python side
// measures the text angle (a phone photo is never perfectly level) before grouping blocks into
// lines. HEIC/JPEG/PNG all load through CoreImage. Built on demand by grocery_receipt_text.py
// (swiftc, cached under .ocr_bin/ keyed by this file's sha256).
import CoreImage
import Foundation
import Vision

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(2)
}

guard CommandLine.arguments.count == 2 else { fail("usage: grocery_receipt_ocr <image>") }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let ci = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else {
  fail("cannot load image: \(url.path)")
}
let context = CIContext(options: nil)
guard let cg = context.createCGImage(ci, from: ci.extent) else { fail("cannot rasterise image: \(url.path)") }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["es-CL", "en-US"]
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
do {
  try handler.perform([request])
} catch {
  fail("vision request failed: \(error)")
}

func pt(_ p: CGPoint) -> [Double] { [Double(p.x), Double(p.y)] }
var blocks: [[String: Any]] = []
for obs in request.results ?? [] {
  guard let candidate = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  blocks.append([
    "text": candidate.string,
    "conf": Double(candidate.confidence),
    "x": Double(b.minX), "y": Double(b.minY), "w": Double(b.width), "h": Double(b.height),
    "tl": pt(obs.topLeft), "tr": pt(obs.topRight), "bl": pt(obs.bottomLeft), "br": pt(obs.bottomRight),
  ])
}
let out: [String: Any] = ["engine": "apple-vision", "width": cg.width, "height": cg.height, "blocks": blocks]
let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
