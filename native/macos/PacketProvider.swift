import Foundation
import NetworkExtension
import Security

final class FilterControl: NSObject, NetworkControlProtocol, NSXPCListenerDelegate {
    static let shared = FilterControl()
    private let mutex = NSLock()
    private var policy: UnsafeMutableRawPointer?
    private var deadline: TimeInterval = 0
    private var owner: Int32 = 0
    private var started = false
    private var listener: NSXPCListener?
    private var timer: DispatchSourceTimer?

    func listen() {
        guard let settings = Bundle.main.object(forInfoDictionaryKey: "NetworkExtension") as? [String: Any],
              let service = settings["NEMachServiceName"] as? String else { exit(2) }
        let listener = NSXPCListener(machServiceName: service)
        listener.delegate = self; listener.resume(); self.listener = listener
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now(), repeating: 1)
        timer.setEventHandler { [weak self] in self?.expire() }
        timer.resume(); self.timer = timer
    }
    func expire() {
        mutex.lock(); defer { mutex.unlock() }
        if policy != nil && ProcessInfo.processInfo.systemUptime > deadline {
            hydro_policy_destroy(policy); policy = nil; owner = 0
        }
    }
    func setStarted(_ value: Bool) {
        mutex.lock(); defer { mutex.unlock() }
        started = value
        if !value { hydro_policy_destroy(policy); policy = nil; owner = 0 }
    }
    func permits(_ bytes: UnsafeRawPointer, size: Int, outbound: Bool) -> Bool {
        mutex.lock(); defer { mutex.unlock() }
        if ProcessInfo.processInfo.systemUptime > deadline { return true }
        return hydro_policy_allows(policy, bytes, size, outbound ? 1 : 0) != 0
    }
    func command(_ operation: String, policy text: String, reply: @escaping (String) -> Void) {
        guard let connection = NSXPCConnection.current() else { reply("UNAUTHORIZED"); return }
        let pid = connection.processIdentifier
        mutex.lock(); defer { mutex.unlock() }
        if operation == "check" { reply(started ? "OK" : "NOT_READY"); return }
        if owner != 0 && owner != pid && ProcessInfo.processInfo.systemUptime <= deadline { reply("FILTER_BUSY"); return }
        if operation == "lock" {
            guard started, let next = hydro_policy_create(text) else { reply(started ? "INVALID_POLICY" : "NOT_READY"); return }
            hydro_policy_destroy(policy); policy = next; owner = pid
            deadline = ProcessInfo.processInfo.systemUptime + 10
        } else if operation == "unlock" {
            hydro_policy_destroy(policy); policy = nil; owner = 0; deadline = 0
        } else if operation == "ping" {
            guard owner == pid, policy != nil, ProcessInfo.processInfo.systemUptime <= deadline else { reply("LEASE_EXPIRED"); return }
            deadline = ProcessInfo.processInfo.systemUptime + 10
        } else { reply("INVALID_COMMAND"); return }
        reply("OK")
    }
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // Only the signed native host from our Developer ID team controls policy.
        guard let team = Bundle.main.object(forInfoDictionaryKey: "HydroTeamID") as? String else { return false }
        var code: SecCode?, requirement: SecRequirement?
        let attributes = [kSecGuestAttributePid as String: connection.processIdentifier] as CFDictionary
        let rule = "anchor apple generic and identifier \"com.exam.proctor\" and certificate leaf[subject.OU] = \"\(team)\""
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
              SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
              let code = code, let requirement = requirement,
              SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return false }
        connection.exportedInterface = NSXPCInterface(with: NetworkControlProtocol.self)
        connection.exportedObject = self
        let pid = connection.processIdentifier
        connection.invalidationHandler = { [weak self] in
            guard let self = self else { return }
            self.mutex.lock(); defer { self.mutex.unlock() }
            if self.owner == pid { hydro_policy_destroy(self.policy); self.policy = nil; self.owner = 0 }
        }
        connection.resume(); return true
    }
}

final class PacketProvider: NEFilterPacketProvider {
    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        packetHandler = { _, _, direction, bytes, length in
            FilterControl.shared.permits(bytes, size: length, outbound: direction == .outbound) ? .allow : .drop
        }
        FilterControl.shared.setStarted(true)
        completionHandler(nil)
    }
    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        FilterControl.shared.setStarted(false); packetHandler = nil; completionHandler()
    }
}
