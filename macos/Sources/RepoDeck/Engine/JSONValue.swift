import Foundation

/// A decoded JSON value of unknown shape.
///
/// The engine returns a few payloads whose keys are open-ended — a knowledge
/// graph document body, a deploy profile the user edited by hand. Rather than
/// mirror every one of those in Swift and break when the engine adds a field,
/// they arrive as `JSONValue` and are read by key where needed.
enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let v = try? container.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? container.decode(Double.self) {
            self = .number(v)
        } else if let v = try? container.decode(String.self) {
            self = .string(v)
        } else if let v = try? container.decode([JSONValue].self) {
            self = .array(v)
        } else if let v = try? container.decode([String: JSONValue].self) {
            self = .object(v)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .number(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .null: try container.encodeNil()
        }
    }

    // MARK: - Reading

    subscript(key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }

    var doubleValue: Double? {
        if case .number(let v) = self { return v }
        return nil
    }

    var intValue: Int? {
        if case .number(let v) = self { return Int(v) }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let v) = self { return v }
        return nil
    }

    var arrayValue: [JSONValue] {
        if case .array(let v) = self { return v }
        return []
    }

    var objectValue: [String: JSONValue] {
        if case .object(let v) = self { return v }
        return [:]
    }

    /// Strings out of an array of strings — the shape most list fields take.
    var stringList: [String] {
        arrayValue.compactMap(\.stringValue)
    }

    /// A plain Swift value, for handing back to `JSONSerialization` on the way out.
    var raw: Any {
        switch self {
        case .string(let v): return v
        case .number(let v): return v
        case .bool(let v): return v
        case .null: return NSNull()
        case .array(let v): return v.map(\.raw)
        case .object(let v): return v.mapValues(\.raw)
        }
    }
}
