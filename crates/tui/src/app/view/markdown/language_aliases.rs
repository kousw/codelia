pub(crate) fn language_aliases(token: &str) -> Vec<String> {
    let lower = token.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    push_aliases(&mut out, aliases_for(&lower));
    push_aliases(&mut out, &[&lower]);
    out
}

fn push_aliases(out: &mut Vec<String>, aliases: &[&str]) {
    for alias in aliases {
        if alias.is_empty() {
            continue;
        }
        if out.iter().any(|current| current == alias) {
            continue;
        }
        out.push((*alias).to_string());
    }
}

fn aliases_for(token: &str) -> &'static [&'static str] {
    match token {
        // TypeScript / JavaScript family
        "ts" | "typescript" => &["typescript", "ts", "javascript", "js"],
        "tsx" => &["tsx", "typescript", "ts", "jsx", "javascript", "js"],
        "js" | "javascript" => &["javascript", "js"],
        "jsx" => &["jsx", "javascript", "js"],
        "mjs" => &["mjs", "javascript", "js"],
        "cjs" => &["cjs", "javascript", "js"],

        // Web / markup
        "html" | "htm" => &["html", "htm"],
        "xml" => &["xml"],
        "svg" => &["svg", "xml"],
        "css" => &["css"],
        "scss" => &["scss", "css"],
        "sass" => &["sass", "scss", "css"],
        "less" => &["less", "css"],

        // Data / config
        "json" => &["json"],
        "jsonc" => &["jsonc", "json"],
        "json5" => &["json5", "json"],
        "yaml" | "yml" => &["yaml", "yml"],
        "toml" => &["toml"],
        "ini" | "cfg" | "conf" => &["ini", "cfg", "conf"],

        // Shell
        "sh" | "shell" | "bash" | "zsh" | "ksh" => &["bash", "sh", "shell", "zsh", "ksh"],
        "fish" => &["fish", "bash", "sh"],
        "powershell" | "pwsh" | "ps1" => &["powershell", "pwsh", "ps1", "psm1"],
        "bat" | "cmd" => &["bat", "cmd"],

        // JVM / compiled languages
        "java" => &["java"],
        "kt" | "kotlin" => &["kotlin", "kt"],
        "scala" => &["scala"],
        "groovy" => &["groovy"],
        "c" => &["c"],
        "h" => &["h", "c"],
        "cpp" | "cxx" | "cc" | "hpp" | "hh" | "hxx" => {
            &["cpp", "c++", "cxx", "cc", "hpp", "hh", "hxx"]
        }
        "cs" | "csharp" => &["c#", "csharp", "cs"],
        "go" | "golang" => &["go", "golang"],
        "rs" | "rust" => &["rust", "rs"],
        "zig" => &["zig"],

        // Scripting / interpreted
        "py" | "python" => &["python", "py"],
        "rb" | "ruby" => &["ruby", "rb"],
        "php" => &["php"],
        "perl" | "pl" => &["perl", "pl"],
        "lua" => &["lua"],
        "r" => &["r"],
        "dart" => &["dart"],

        // Functional / misc
        "swift" => &["swift"],
        "objective-c" | "objc" => &["objective-c", "objc", "m"],
        "elixir" | "ex" | "exs" => &["elixir", "ex", "exs"],
        "erlang" | "erl" => &["erlang", "erl"],
        "haskell" | "hs" => &["haskell", "hs"],
        "ocaml" | "ml" => &["ocaml", "ml"],
        "fsharp" | "fs" => &["f#", "fsharp", "fs"],

        // SQL / infra
        "sql" => &["sql"],
        "graphql" | "gql" => &["graphql", "gql"],
        "dockerfile" | "docker" => &["dockerfile", "docker"],
        "nginx" => &["nginx", "conf"],

        // Docs / plain text
        "md" | "markdown" | "mdx" => &["markdown", "md", "mdx"],
        "text" | "txt" | "plain" | "plaintext" => &["txt", "text", "plain", "plaintext"],

        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::language_aliases;

    #[test]
    fn aliases_cover_typescript_family() {
        let aliases = language_aliases("tsx");
        assert!(aliases.contains(&"tsx".to_string()));
        assert!(aliases.contains(&"typescript".to_string()));
        assert!(aliases.contains(&"javascript".to_string()));
    }

    #[test]
    fn aliases_cover_shell_family() {
        let aliases = language_aliases("shell");
        assert!(aliases.contains(&"bash".to_string()));
        assert!(aliases.contains(&"sh".to_string()));
    }

    #[test]
    fn aliases_preserve_unknown_token() {
        let aliases = language_aliases("mycustomlang");
        assert_eq!(aliases, vec!["mycustomlang".to_string()]);
    }
}
