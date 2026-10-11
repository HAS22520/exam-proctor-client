import Foundation
import NetworkExtension

NEProvider.startSystemExtensionMode()
FilterControl.shared.listen()
dispatchMain()
