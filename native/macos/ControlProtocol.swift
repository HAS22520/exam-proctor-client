import Foundation

@objc protocol NetworkControlProtocol {
    func command(_ operation: String, policy: String, reply: @escaping (String) -> Void)
}
