import AppKit
import Foundation
import Darwin

let host = Host()
let args = CommandLine.arguments
if args.count != 3 || args[1] != "--parent" || Int32(args[2]) == nil { exit(2) }
let parent = Int32(args[2])!
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.accessory)
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now() + 1, repeating: 1)
timer.setEventHandler { if getppid() != parent || kill(parent, 0) != 0 { host.shutdown() } }
timer.resume()
DispatchQueue.global().async {
    while let line = readLine(), line.utf8.count <= 70000 { DispatchQueue.main.async { host.line(line) } }
    DispatchQueue.main.async { host.shutdown() }
}
NSApplication.shared.run()
