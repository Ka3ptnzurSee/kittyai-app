import WidgetKit
import SwiftUI

struct KittyEntry: TimelineEntry {
    let date: Date
}

struct KittyProvider: TimelineProvider {
    func placeholder(in context: Context) -> KittyEntry { KittyEntry(date: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (KittyEntry) -> Void) {
        completion(KittyEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<KittyEntry>) -> Void) {
        completion(Timeline(entries: [KittyEntry(date: Date())], policy: .never))
    }
}

struct KittyLauncherWidget: Widget {
    let kind = "KittyLauncherWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: KittyProvider()) { entry in
            KittyLauncherView()
        }
        .configurationDisplayName("KittyAI")
        .description("Chat, Sprache oder letzte Chats direkt vom Homescreen.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct KittyLauncherView: View {
    private func tile(_ systemImage: String, _ title: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage).font(.system(size: 15, weight: .semibold))
            Text(title).font(.system(size: 14, weight: .semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(Color.secondary.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "cat.fill").font(.system(size: 13))
                Text("KittyAI").font(.system(size: 13, weight: .bold))
            }
            .foregroundStyle(Color.accentColor)

            Link(destination: URL(string: "kittyai://new")!) {
                tile("square.and.pencil", "Neuer Chat")
            }
            Link(destination: URL(string: "kittyai://voice")!) {
                tile("mic.fill", "Sprachmodus")
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(.primary)
        .containerBackground(for: .widget) {
            Color(.systemBackground)
        }
    }
}
