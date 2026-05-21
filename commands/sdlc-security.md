---
description: Run security review using Security Agent
---

# Security Review

Perform security review on: $ARGUMENTS

## Instructions

Use the **security-agent** subagent to:

1. Review code for vulnerabilities (SAST)
2. Audit dependencies for known CVEs
3. Check for hardcoded secrets
4. Verify compliance requirements
5. Assess security architecture

## Scope

```
Target: $ARGUMENTS
Type: Security Review (no deployment)
```

## Security Checklist

### Code Analysis
- [ ] SQL Injection (parameterized queries)
- [ ] XSS (output encoding)
- [ ] CSRF (tokens on state changes)
- [ ] Authentication implementation
- [ ] Authorization checks
- [ ] Input validation
- [ ] Error handling (no stack traces exposed)
- [ ] Logging (no sensitive data)

### Secrets Detection
- [ ] No hardcoded API keys
- [ ] No hardcoded passwords
- [ ] No hardcoded tokens
- [ ] .env files in .gitignore

### Dependencies
- [ ] npm audit / pip-audit
- [ ] Check for critical CVEs
- [ ] Check for outdated packages

### Compliance
- [ ] Authentication method appropriate
- [ ] Data encryption (transit & rest)
- [ ] Audit logging enabled
- [ ] Access controls implemented

## Severity Classification

| Severity | Action Required |
|----------|-----------------|
| Critical | BLOCK - Must fix immediately |
| High | BLOCK - Must fix before release |
| Medium | Document - Plan remediation |
| Low | Track - Add to backlog |

## Output Format

Document findings as:

```markdown
## SEC-[ID]: [Title]
**Severity**: Critical | High | Medium | Low
**Category**: [injection | auth | crypto | config | dependency]
**Location**: [file:line]
**Description**: [What is the issue]
**Impact**: [What could happen]
**Remediation**: [How to fix]
```

Begin security review now.
