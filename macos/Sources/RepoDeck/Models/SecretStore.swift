import Foundation
import Security

/// The Keychain, which is where every credential RepoDeck holds actually lives.
///
/// The engine's database stores only a *ref* — the account name used here — so
/// a copy of the sqlite file carries no secrets. At launch the app reads the
/// refs it knows about and pushes their values down the engine's stdin pipe,
/// where they stay in memory for the session and nowhere else.
enum SecretStore {
    private static let service = "com.repodeck.app"

    /// Refs are namespaced so a GitHub token and a model key can't collide.
    static func ref(_ kind: String, _ name: String) -> String {
        "\(kind)/\(name)"
    }

    @discardableResult
    static func set(_ value: String, for ref: String) -> Bool {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: ref,
        ]

        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }

        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ ref: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: ref,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func delete(_ ref: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: ref,
        ]
        return SecItemDelete(query as CFDictionary) == errSecSuccess
    }

    /// Every ref RepoDeck has stored, so the app can hand the engine the whole
    /// set in one call rather than discovering them one failure at a time.
    static func allRefs() -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
              let entries = items as? [[String: Any]]
        else { return [] }
        return entries.compactMap { $0[kSecAttrAccount as String] as? String }
    }

    /// The `{ ref: value }` map the engine expects from `app.secrets`.
    static func bundle(for refs: [String]) -> [String: String] {
        var out: [String: String] = [:]
        for ref in refs {
            if let value = get(ref) { out[ref] = value }
        }
        return out
    }
}
