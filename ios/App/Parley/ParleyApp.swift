import SwiftUI

@main
struct ParleyApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            TabView {
                LiveView()
                    .tabItem { Label("錄音", systemImage: "record.circle") }
                LibraryView()
                    .tabItem { Label("錄音庫", systemImage: "rectangle.stack") }
                SettingsView()
                    .tabItem { Label("設定", systemImage: "gearshape") }
            }
            .environmentObject(app)
            .preferredColorScheme(app.theme.colorScheme)
            .task { await app.refreshSession() }
        }
    }
}
