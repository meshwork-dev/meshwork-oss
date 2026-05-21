---
name: security
description: Security review patterns — OWASP Top 10, SAST/DAST checklists, dependency scanning, compliance frameworks, threat modelling. Use for security reviews, vulnerability assessments, scan scheduling, compliance checks, or when writing security-related Jira issues.
last_updated: 2026-03-29
---

# Security Review Patterns

## OWASP Top 10 (2021) Checklist

| # | Category | What to Check |
|---|----------|---------------|
| A01 | Broken Access Control | Role checks on every endpoint, IDOR tests, CORS config, directory traversal |
| A02 | Cryptographic Failures | TLS everywhere, no hardcoded secrets, proper key management, hashing (bcrypt/argon2) |
| A03 | Injection | Parameterized queries, input validation, ORM usage, no raw SQL/shell exec |
| A04 | Insecure Design | Threat model exists, rate limiting, business logic abuse scenarios |
| A05 | Security Misconfiguration | Default credentials removed, error messages sanitized, headers (CSP, HSTS, X-Frame) |
| A06 | Vulnerable Components | Dependencies up to date, no known CVEs, lock files committed |
| A07 | Auth Failures | MFA available, session timeouts, password policy, brute-force protection |
| A08 | Data Integrity | CI/CD pipeline integrity, signed artifacts, dependency verification |
| A09 | Logging Failures | Security events logged, no sensitive data in logs, alerting on anomalies |
| A10 | SSRF | URL validation, allowlists for external calls, no user-controlled URLs in server requests |

## Security Review Process

### Code Review Checklist
```
[ ] Authentication: All endpoints require auth (unless explicitly public)
[ ] Authorization: Role/permission checks at handler level (not just middleware)
[ ] Input validation: All user input validated (type, length, format, range)
[ ] Output encoding: HTML/JS/URL encoding on output (XSS prevention)
[ ] SQL/NoSQL: Parameterized queries only, no string concatenation
[ ] File uploads: Type validation, size limits, no execution from upload dir
[ ] Secrets: No hardcoded credentials, API keys, tokens in code
[ ] Dependencies: No known critical/high CVEs in dependency tree
[ ] Error handling: Generic errors to client, detailed errors to logs only
[ ] Headers: Security headers set (CSP, HSTS, X-Content-Type-Options, etc.)
[ ] CORS: Explicit origin allowlist, no wildcard in production
[ ] Rate limiting: Applied to auth endpoints, API endpoints, file uploads
[ ] Logging: Auth events, access control failures, input validation failures logged
```

### Dependency Scanning
```bash
# Node.js
npm audit --production
npx audit-ci --config audit-ci.json

# Python
pip-audit
safety check

# General
trivy fs --scanners vuln .
grype dir:.
```

### SAST Patterns
Look for these code patterns during static analysis:

| Pattern | Risk | Fix |
|---------|------|-----|
| `eval()`, `Function()`, `exec()` | Code injection | Remove or use safe alternatives |
| `innerHTML`, `dangerouslySetInnerHTML` | XSS | Use textContent or sanitize |
| `child_process.exec(userInput)` | Command injection | Use execFile with args array |
| `fs.readFile(userInput)` | Path traversal | Validate against allowlist |
| `new RegExp(userInput)` | ReDoS | Use safe-regex or fixed patterns |
| `crypto.createHash('md5')` | Weak hash | Use SHA-256+ or bcrypt for passwords |
| `JWT_SECRET` in source | Secret exposure | Use environment variables |
| `cors({ origin: '*' })` | CORS bypass | Explicit origin allowlist |
| `{ secure: false }` on cookies | Session hijack | Set secure: true in production |

## Threat Modelling (STRIDE)

| Threat | Question | Mitigation |
|--------|----------|------------|
| **S**poofing | Can an attacker impersonate a user or service? | Strong auth, mutual TLS, API keys |
| **T**ampering | Can data be modified in transit or at rest? | Integrity checks, signed payloads, checksums |
| **R**epudiation | Can actions be denied? | Audit logs, timestamps, non-repudiation |
| **I**nformation Disclosure | Can sensitive data leak? | Encryption, access controls, data classification |
| **D**enial of Service | Can the service be overwhelmed? | Rate limiting, auto-scaling, circuit breakers |
| **E**levation of Privilege | Can a user gain higher access? | Least privilege, role separation, input validation |

## Compliance Quick Reference

### SOC 2 Type II — Key Controls
- Access control reviews (quarterly)
- Change management process documented
- Incident response plan tested annually
- Encryption at rest and in transit
- Vendor risk assessments
- Employee security training

### ISO 27001 — Key Clauses
- A.5: Information security policies
- A.6: Organisation of information security
- A.8: Asset management
- A.9: Access control
- A.12: Operations security
- A.14: System acquisition, development, maintenance
- A.16: Incident management
- A.18: Compliance

### GDPR Essentials
- Data minimization (collect only what's needed)
- Purpose limitation (use only for stated purpose)
- Right to erasure (soft delete → hard delete pipeline)
- Data portability (export in machine-readable format)
- Privacy by design (security from the start, not bolted on)
- Breach notification (72 hours to authority)

## Scan Scheduling Recommendations
| Scan Type | Frequency | Tool Examples |
|-----------|-----------|---------------|
| Dependency audit | Every CI build + weekly full | npm audit, Snyk, Dependabot |
| SAST | Every PR | Semgrep, CodeQL, SonarQube |
| DAST | Weekly on staging | OWASP ZAP, Burp Suite |
| Container scan | Every build | Trivy, Grype |
| Secret scan | Every commit (pre-commit hook) | Gitleaks, TruffleHog |
| Penetration test | Annually or after major changes | Manual + automated |

## Severity Classification
| Level | Definition | SLA |
|-------|-----------|-----|
| Critical | Actively exploitable, data breach risk | Fix within 24h |
| High | Exploitable with moderate effort | Fix within 7 days |
| Medium | Requires specific conditions to exploit | Fix within 30 days |
| Low | Minimal risk, defence-in-depth | Fix within 90 days |
| Info | Best practice recommendation | Backlog |
