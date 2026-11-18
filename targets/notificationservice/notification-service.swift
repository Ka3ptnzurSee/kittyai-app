import UserNotifications

// Rich-Push: haengt ein Bild an die Mitteilung, wenn der Payload
//   { "aps": { "mutable-content": 1 }, "image": "https://…" }
// enthaelt. Ohne Bild bleibt die Mitteilung unveraendert.
class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        self.bestAttempt = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let content = bestAttempt,
              let urlString = request.content.userInfo["image"] as? String,
              let url = URL(string: urlString)
        else {
            deliver()
            return
        }

        // Bild-URL steht unter userInfo["image"]; ohne Bild bleibt die Mitteilung unveraendert.
        download(url) { fileURL in
            defer { self.deliver() }
            guard let fileURL else { return }
            let ext = fileURL.pathExtension.isEmpty ? "jpg" : fileURL.pathExtension
            let target = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(ext)
            guard (try? FileManager.default.moveItem(at: fileURL, to: target)) != nil else { return }
            if let attachment = try? UNNotificationAttachment(
                identifier: "kitty-image",
                url: target,
                options: nil
            ) {
                content.attachments = [attachment]
            }
        }
    }

    private func download(_ url: URL, completion: @escaping (URL?) -> Void) {
        let task = URLSession.shared.downloadTask(with: url) { local, _, _ in
            completion(local)
        }
        task.resume()
    }

    private func deliver() {
        if let contentHandler, let bestAttempt {
            contentHandler(bestAttempt)
        }
        contentHandler = nil
        bestAttempt = nil
    }

    override func serviceExtensionTimeWillExpire() {
        deliver()
    }
}
