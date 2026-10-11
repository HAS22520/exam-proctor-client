import AppKit
import Foundation
import NetworkExtension
import SystemExtensions
import Darwin

final class Host: NSObject, OSSystemExtensionRequestDelegate {
    private var connection: NSXPCConnection?
    private var activation: ((String?) -> Void)?
    private var busy = false
    private var monitoring = false
    private let extensionID = "com.exam.proctor.network-filter"
    private var extensionBundle: Bundle? {
        Bundle(url: Bundle.main.bundleURL.appendingPathComponent("Contents/Library/SystemExtensions/\(extensionID).systemextension"))
    }
    func emit(_ object: [String: Any]) {
        if let bytes = try? JSONSerialization.data(withJSONObject: object) {
            FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
        }
    }
    func reply(_ id: Int, _ code: String = "OK") {
        emit(["id": id, "protocol": 1, "ok": code == "OK", "code": code])
    }
    func rpc(_ operation: String, _ policy: String = "", done: @escaping (String) -> Void) {
        if connection == nil {
            guard let settings = extensionBundle?.object(forInfoDictionaryKey: "NetworkExtension") as? [String: Any],
                  let service = settings["NEMachServiceName"] as? String else { done("NATIVE_MISSING"); return }
            let connection = NSXPCConnection(machServiceName: service, options: [])
            connection.remoteObjectInterface = NSXPCInterface(with: NetworkControlProtocol.self)
            connection.invalidationHandler = { [weak self] in DispatchQueue.main.async { self?.connection = nil } }
            connection.resume(); self.connection = connection
        }
        guard let proxy = connection?.remoteObjectProxyWithErrorHandler({ [weak self] _ in
            DispatchQueue.main.async { self?.connection?.invalidate(); self?.connection = nil; done("NOT_READY") }
        }) as? NetworkControlProtocol else { done("NOT_READY"); return }
        proxy.command(operation, policy: policy) { code in DispatchQueue.main.async { done(code) } }
    }
    func prepare(_ done: @escaping (String?) -> Void) {
        guard extensionBundle != nil else { done("NATIVE_MISSING"); return }
        emit(["event": "stage", "phase": "approve-network-extension"])
        activation = { [weak self] error in
            if let error = error { done(error); return }
            self?.configure(done)
        }
        let request = OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: extensionID, queue: .main)
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }
    func configure(_ done: @escaping (String?) -> Void) {
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { [weak self] error in
            DispatchQueue.main.async {
                if error != nil { done("APPROVAL_REQUIRED"); return }
                if manager.isEnabled && manager.providerConfiguration?.filterPacketProviderBundleIdentifier == self?.extensionID { done(nil); return }
                let configuration = NEFilterProviderConfiguration()
                configuration.filterPackets = true; configuration.filterSockets = false
                configuration.filterPacketProviderBundleIdentifier = self?.extensionID
                manager.providerConfiguration = configuration
                manager.localizedDescription = "Hydro 监考临时网络过滤"
                manager.isEnabled = true
                manager.saveToPreferences { error in DispatchQueue.main.async { done(error == nil ? nil : "APPROVAL_REQUIRED") } }
            }
        }
    }
    func lock(_ id: Int, _ policy: String, remaining: Int = 30) {
        rpc("lock", policy) { [weak self] code in
            guard let self = self else { return }
            if code == "NOT_READY" && remaining > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.lock(id, policy, remaining: remaining - 1) }; return
            }
            self.busy = false; self.monitoring = code == "OK"; self.reply(id, code == "NOT_READY" ? "FILTER_FAILED" : code)
        }
    }
    func line(_ line: String) {
        let fields = line.components(separatedBy: "\t")
        guard fields.count >= 2, let id = Int(fields[0]) else { return }
        let op = fields[1], policy = fields.count > 2 ? fields[2] : ""
        if op == "ping" {
            if monitoring { rpc("ping") { [weak self] code in
                if code != "OK" { self?.monitoring = false; self?.emit(["event": "lease-expired"]) }
            } }; return
        }
        if op == "check" { reply(id); return }
        if busy { reply(id, "FILTER_BUSY"); return }
        if op == "lock" {
            busy = true
            // A running provider only needs a lightweight XPC policy swap.
            rpc("check") { [weak self] code in
                guard let self = self else { return }
                if code == "OK" { self.lock(id, policy); return }
                self.prepare { error in
                    if let error = error { self.busy = false; self.reply(id, error) }
                    else { self.emit(["event": "stage", "phase": "apply-native-policy"]); self.lock(id, policy) }
                }
            }
        } else if op == "unlock" {
            if !monitoring { reply(id); return }
            emit(["event": "stage", "phase": "remove-native-policy"])
            rpc("unlock") { [weak self] code in
                self?.monitoring = false; self?.reply(id, code)
            }
        } else { reply(id, "INVALID_COMMAND") }
    }
    func shutdown() {
        // Invalidating the owning XPC connection releases its lease immediately;
        // provider's monotonic 10s lease also covers kills, crashes and hangs.
        connection?.invalidate(); exit(0)
    }
    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        let callback = activation; activation = nil
        callback?(result == .completed ? nil : "REBOOT_REQUIRED")
    }
    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        let callback = activation; activation = nil; callback?("APPROVAL_REQUIRED")
    }
    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        emit(["event": "stage", "phase": "approve-network-extension"])
    }
    func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension extension: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction { .replace }
}

