import UIKit
import Social
import UniformTypeIdentifiers

// Nimmt Text/Links/Bilder aus dem Teilen-Menue entgegen und legt sie in den
// gemeinsamen App-Group-UserDefaults ab. Die KittyAI-App liest den Eintrag
// beim naechsten Vordergrund-Wechsel (ExtensionStorage aus @bacons/apple-targets).
private let appGroup = "group.com.meister.piapp"
private let pendingKey = "kittyai.pendingShare"

final class ShareViewController: UIViewController {
    private let titleLabel = UILabel()
    private let previewLabel = UILabel()
    private let sendButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var collectedText: String = ""
    private var collectedURL: String = ""

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        titleLabel.text = "An KittyAI senden"
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        previewLabel.text = "Inhalt wird geladen …"
        previewLabel.font = .systemFont(ofSize: 15)
        previewLabel.textColor = .secondaryLabel
        previewLabel.numberOfLines = 5
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

        loadSharedItem()
    }

    private func loadSharedItem() {
        guard let item = (extensionContext?.inputItems.first as? NSExtensionItem) else { return }
        if let text = item.attributedContentText?.string, !text.isEmpty {
            collectedText = text
        }
        for provider in item.attachments ?? [] {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] data, _ in
                    guard let self else { return }
                    let value = (data as? URL)?.absoluteString ?? (data as? String)
                    if let value, !value.isEmpty { self.collectedURL = value }
                    self.updatePreview()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] data, _ in
                    guard let self else { return }
                    if let text = data as? String, !text.isEmpty { self.collectedText = text }
                    self.updatePreview()
                }
            }
        }
        updatePreview()
    }

    private func updatePreview() {
        let text = [collectedURL, collectedText].filter { !$0.isEmpty }.joined(separator: "\n")
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.previewLabel.text = text.isEmpty ? "Kein Text erkannt" : text
            self.sendButton.isEnabled = !text.isEmpty
            self.sendButton.alpha = text.isEmpty ? 0.4 : 1
        }
    }

    @objc private func send() {
        let payload: [String: Any] = [
            "text": collectedText,
            "url": collectedURL,
            "ts": Date().timeIntervalSince1970,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let json = String(data: data, encoding: .utf8) {
            UserDefaults(suiteName: appGroup)?.set(json, forKey: pendingKey)
            UserDefaults(suiteName: appGroup)?.synchronize()
        }
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    @objc private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "KittyAI", code: -1))
    }
}
