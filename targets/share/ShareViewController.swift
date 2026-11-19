import UIKit
import UniformTypeIdentifiers

// Nimmt Text, Links, Bilder und Dateien aus dem Teilen-Menue entgegen und legt sie
// in der App Group ab (UserDefaults + Container-Ordner "share-inbox"). Die KittyAI-App
// liest den Eintrag beim naechsten Vordergrund-Wechsel und haengt alles an den Chat.
private let appGroup = "group.com.meister.piapp"
private let pendingKey = "kittyai.pendingShare"

final class ShareViewController: UIViewController {
    private let titleLabel = UILabel()
    private let previewLabel = UILabel()
    private let sendButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var collectedText: String = ""
    private var collectedURL: String = ""
    private var collectedFiles: [[String: String]] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        titleLabel.text = "An KittyAI senden"
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        previewLabel.text = "Inhalt wird geladen ..."
        previewLabel.font = .systemFont(ofSize: 15)
        previewLabel.textColor = .secondaryLabel
        previewLabel.numberOfLines = 6
        previewLabel.translatesAutoresizingMaskIntoConstraints = false

        sendButton.setTitle("Senden", for: .normal)
        sendButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        sendButton.addTarget(self, action: #selector(send), for: .touchUpInside)
        sendButton.translatesAutoresizingMaskIntoConstraints = false

        cancelButton.setTitle("Abbrechen", for: .normal)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false

        for v in [titleLabel, previewLabel, sendButton, cancelButton] { view.addSubview(v) }

        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            titleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            titleLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            previewLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 16),
            previewLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            previewLabel.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            cancelButton.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            cancelButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
            sendButton.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            sendButton.bottomAnchor.constraint(equalTo: cancelButton.bottomAnchor),
        ])

        loadSharedItems()
    }

    private func loadSharedItems() {
        guard let item = (extensionContext?.inputItems.first as? NSExtensionItem) else { return }
        if let text = item.attributedContentText?.string, !text.isEmpty { collectedText = text }
        for provider in item.attachments ?? [] { handle(provider: provider) }
        updatePreview()
    }

    private func handle(provider: NSItemProvider) {
        let ids = provider.registeredTypeIdentifiers
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] data, _ in
                guard let self else { return }
                let value = (data as? URL)?.absoluteString ?? (data as? String)
                if let value, !value.isEmpty { self.collectedURL = value }
                DispatchQueue.main.async { self.updatePreview() }
            }
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            copyFile(provider: provider, typeIdentifier: UTType.image.identifier)
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
            copyFile(provider: provider, typeIdentifier: UTType.pdf.identifier)
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] data, _ in
                guard let self else { return }
                if let text = data as? String, !text.isEmpty { self.collectedText = text }
                DispatchQueue.main.async { self.updatePreview() }
            }
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            copyFile(provider: provider, typeIdentifier: UTType.data.identifier)
            return
        }
        if let first = ids.first { copyFile(provider: provider, typeIdentifier: first) }
    }

    // Datei-/Bildanhaenge: in den App-Group-Container kopieren. Die temporaere URL aus
    // loadFileRepresentation ist nur innerhalb des Callbacks gueltig, also sofort kopieren.
    private func copyFile(provider: NSItemProvider, typeIdentifier: String) {
        provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, _ in
            guard let self else { return }
            guard let url else { return }
            guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return }
            let inbox = container.appendingPathComponent("share-inbox", isDirectory: true)
            try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
            let original = url.lastPathComponent.isEmpty ? "datei" : url.lastPathComponent
            let dest = inbox.appendingPathComponent(original)
            try? FileManager.default.removeItem(at: dest)
            do { try FileManager.default.copyItem(at: url, to: dest) } catch { return }
            DispatchQueue.main.async {
                self.collectedFiles.append(["path": dest.path, "name": original])
                self.updatePreview()
            }
        }
    }

    private func summaryText() -> String {
        var parts: [String] = []
        if !collectedURL.isEmpty { parts.append(collectedURL) }
        if !collectedText.isEmpty { parts.append(collectedText) }
        for f in collectedFiles {
            if let name = f["name"] { parts.append("[Datei] " + name) }
        }
        return parts.joined(separator: "\n")
    }

    private func updatePreview() {
        let summary = summaryText()
        previewLabel.text = summary.isEmpty ? "Kein Inhalt erkannt" : summary
        let enabled = !summary.isEmpty
        sendButton.isEnabled = enabled
        sendButton.alpha = enabled ? 1 : 0.4
    }

    @objc private func send() {
        let payload: [String: Any] = [
            "text": collectedText,
            "url": collectedURL,
            "files": collectedFiles,
            "ts": Date().timeIntervalSince1970,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let json = String(data: data, encoding: .utf8) {
            let defaults = UserDefaults(suiteName: appGroup)
            defaults?.set(json, forKey: pendingKey)
            defaults?.synchronize()
        }
        // App direkt oeffnen, damit der Nutzer den Text nicht selbst hinueberkopieren muss.
        // Schlaegt das fehl (Apple erlaubt das nicht jeder Extension), bleibt der Eintrag
        // in der App Group liegen und wird beim naechsten Start gelesen.
        if let url = URL(string: "kittyai://share") {
            extensionContext?.open(url, completionHandler: { _ in
                self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            })
        } else {
            extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
    }

    @objc private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "KittyAI", code: -1))
    }
}
