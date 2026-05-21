---
description: Run AI-SDLC code review workflow with security and quality checks.
---

# AI-SDLC Code Review

Perform comprehensive code review on: $ARGUMENTS

## Review Workflow

### Step 1: Architecture Review
Use the **architect-jets** subagent:
```
Review the code architecture for:
- Layered architecture compliance
- SOLID principles
- Design patterns
- Separation of concerns
```

### Step 2: Code Quality Review  
Use the **software-engineer** subagent:
```
Review code quality for:
- Code style and consistency
- Test coverage
- Error handling
- Documentation
- Technical debt
```

### Step 3: Security Review
Use the **security-agent** subagent:
```
Review security for:
- Vulnerability scan
- Dependency audit
- Secrets detection
- OWASP Top 10 compliance
```

### Step 4: QA Assessment
Use the **qa-agent** subagent:
```
Assess testability and quality:
- Test coverage adequacy
- Missing test scenarios
- Integration test needs
```

## Generate Review Report

```markdown
# Code Review Report

**Reviewed**: $ARGUMENTS
**Date**: [timestamp]

## Architecture Assessment
- Layered architecture: ✅/❌
- SOLID compliance: ✅/❌
- Issues found: [list]

## Code Quality
- Style consistency: ✅/❌
- Test coverage: [X]%
- Documentation: ✅/❌
- Issues found: [list]

## Security Assessment
- Critical issues: [N]
- High issues: [N]
- Medium issues: [N]
- Recommendations: [list]

## Overall Verdict
☑️ APPROVED | ☐ APPROVED WITH COMMENTS | ☐ CHANGES REQUESTED

## Action Items
1. [Item 1]
2. [Item 2]
```

Begin the review workflow now.
