---
description: Deploy application using DevOps/SRE Agent (after security and QA pass)
---

# Deploy Application

Deploy to environment: $ARGUMENTS

## Prerequisites

Before deployment, verify:
- [ ] Security review passed (check `docs/sdlc/security/`)
- [ ] QA tests passed (check `docs/sdlc/testing/`)

## Instructions

Use the **atlas-agent** subagent to deploy the application.

## Deployment Target

```
Environment: $ARGUMENTS (staging | production)
```

## Pre-Deployment Checklist

The DevOps/SRE Agent will verify:
- Security gate: 0 critical/high vulnerabilities
- QA gate: All tests passing
- Build artifacts ready
- Rollback plan documented
- Monitoring configured

## Post-Deployment

After successful deployment:
- Customer Agent will perform acceptance testing
- Monitor dashboards for 15-30 minutes
- Verify health checks passing

## Usage Examples

```
/sdlc-deploy staging
/sdlc-deploy production
```

Begin deployment now.
