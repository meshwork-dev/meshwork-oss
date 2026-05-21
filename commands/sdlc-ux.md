---
description: Run UX design phase only using UX Agent
---

# UX Design & Research

Design user experience for: $ARGUMENTS

## Instructions

Use the **ux-agent** subagent to:

1. Conduct UX research and create user personas
2. Design information architecture and user flows
3. Create design system specifications
4. Design wireframes and mockups
5. Ensure WCAG 2.1 AAA accessibility compliance
6. Validate usability and performance

## Context

```
Request: $ARGUMENTS
Inputs:
  - Requirements: docs/sdlc/requirements/REQ-*.md (if available)
  - Architecture: docs/sdlc/architecture/ARCH-*.md (if available)

Outputs:
  - UX Research: docs/sdlc/ux/UX-RESEARCH-[timestamp].md
  - Design System: docs/sdlc/ux/DESIGN-SYSTEM-[timestamp].md
  - Wireframes: docs/sdlc/ux/WIREFRAMES-[timestamp].md
  - Components: docs/sdlc/ux/components/
```

## Quality Gates

Before completing, ensure:
- [ ] User personas and journey maps created
- [ ] Design system documented (colors, typography, spacing, components)
- [ ] WCAG 2.1 AAA accessibility requirements met
- [ ] Wireframes/mockups for all key user flows
- [ ] Responsive design strategy (mobile-first)
- [ ] Component library designed for reusability
- [ ] Performance budget defined (Core Web Vitals)
- [ ] Usability goals quantified (task completion rate, error rate, satisfaction)

## UX Phase Deliverables

### Phase 1: UX Research
- User personas with goals and pain points
- User journey maps
- Competitive analysis
- Usability goals and metrics
- Accessibility requirements

### Phase 2: Design System
- Color palette (accessible)
- Typography scale
- Spacing system
- Component library (atomic design)
- Icon library
- Animation principles

### Phase 3: Wireframes & Prototypes
- Low-fidelity wireframes
- High-fidelity mockups
- Interactive prototype
- Responsive variants (mobile, tablet, desktop)
- Dark mode variants (if applicable)

### Phase 4: Design Validation
- Nielsen's usability heuristics check
- WCAG 2.1 AAA compliance verification
- Core Web Vitals performance targets
- Design consistency audit

## Success Metrics

Track these metrics:
- **Accessibility**: WCAG 2.1 AAA = 100%
- **Usability**: Task completion rate >95%, Error rate <2%
- **Satisfaction**: User satisfaction >4.5/5
- **Performance**: LCP <2.5s, FID <100ms, CLS <0.1
- **Consistency**: Component reuse >80%

## Output Format

Create files at:
- `docs/sdlc/ux/UX-RESEARCH-[YYYYMMDD-HHMM].md`
- `docs/sdlc/ux/DESIGN-SYSTEM-[YYYYMMDD-HHMM].md`
- `docs/sdlc/ux/WIREFRAMES-[YYYYMMDD-HHMM].md`
- `docs/sdlc/ux/components/` (component specifications)
- `docs/sdlc/ux/assets/` (design assets)

Include:
- User research findings
- Design system specification
- Wireframes and mockups
- Accessibility compliance report
- Performance requirements
- Implementation guidelines for engineers

Begin UX design phase now.
