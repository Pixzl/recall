interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai_key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github_token", re: /\bgh[opsu]_[A-Za-z0-9]{30,}\b/g },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  {
    name: "pem_block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: "kv_secret",
    re: /\b(?:password|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9._/+=-]{8,})["']?/gi,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (match, captured) => {
      if (p.name === "kv_secret" && captured) {
        return match.replace(captured, `[REDACTED:${p.name}]`);
      }
      return `[REDACTED:${p.name}]`;
    });
  }
  return out;
}

export function hasSecret(text: string): boolean {
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    if (p.re.test(text)) return true;
  }
  return false;
}
