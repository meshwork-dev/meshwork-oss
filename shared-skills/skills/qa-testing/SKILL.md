---
name: qa-testing
description: QA and testing strategy — test pyramids, coverage frameworks, test patterns, regression strategy, E2E best practices, Playwright patterns. Use for writing tests, test planning, quality gates, test strategy, or when reviewing test coverage.
last_updated: 2026-03-29
---

# QA & Testing Strategy

## Test Pyramid

```
         /  E2E  \          Few, slow, high confidence
        / Integration \      Moderate count, moderate speed
       /    Unit Tests   \   Many, fast, isolated
```

| Layer | Count | Speed | What It Tests |
|-------|-------|-------|---------------|
| Unit | Many (70%) | Fast (<100ms) | Functions, logic, transformations |
| Integration | Some (20%) | Medium (<5s) | API endpoints, DB queries, service interactions |
| E2E | Few (10%) | Slow (<60s) | Critical user journeys, cross-system flows |

## Test Strategy Framework

### Coverage Approach
1. **Critical path first** — test what breaks the business (auth, payments, core workflows)
2. **Boundary conditions** — off-by-one, empty inputs, max values, unicode
3. **Error paths** — what happens when dependencies fail?
4. **Regression** — every bug fix gets a test that reproduces the bug

### What NOT to Test
- Third-party library internals (trust the library, test your usage)
- Framework boilerplate (getters/setters, config files)
- Implementation details (test behavior, not how it works)
- One-off scripts (unless they run in production)

## Test Patterns

### Arrange-Act-Assert (AAA)
```
// Arrange — set up test data and preconditions
const user = createTestUser({ role: 'admin' });

// Act — execute the thing being tested
const result = await assignPermission(user, 'delete');

// Assert — verify the outcome
expect(result.permissions).toContain('delete');
```

### Given-When-Then (BDD)
```
Given a user with admin role
When they request delete permission
Then the permission is granted
And it appears in their permission list
```

### Test Data Patterns
| Pattern | When | Example |
|---------|------|---------|
| Builder | Complex objects with many fields | `UserBuilder().withRole('admin').build()` |
| Factory | Reusable test data creation | `createTestUser({ overrides })` |
| Fixture | Shared static data | JSON/SQL files loaded before tests |
| Fake | External service replacement | In-memory database, mock API |
| Snapshot | UI component output | `expect(component).toMatchSnapshot()` |

### Mocking Strategy
| Dependency | Mock? | Reason |
|-----------|-------|--------|
| External APIs | Yes | Unreliable, slow, costs money |
| Database | Integration: No, Unit: Yes | Integration tests need real DB |
| File system | Usually yes | Isolation, speed |
| Time/dates | Yes | Deterministic tests |
| Internal modules | Rarely | Test behavior, not wiring |

## E2E / Playwright Patterns

### Page Object Model
```typescript
class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/login');
  }

  async login(email: string, password: string) {
    await this.page.fill('[data-testid="email"]', email);
    await this.page.fill('[data-testid="password"]', password);
    await this.page.click('[data-testid="submit"]');
  }

  async expectLoggedIn() {
    await expect(this.page.locator('[data-testid="dashboard"]')).toBeVisible();
  }
}
```

### E2E Best Practices
1. **Use `data-testid`** — not CSS classes or element structure
2. **Wait for state, not time** — `waitForSelector` not `waitForTimeout`
3. **One assertion per concept** — test one user journey per spec
4. **Isolate test data** — each test creates its own data, cleans up after
5. **Retry flaky assertions** — use `toPass()` or `expect.poll()` for async state
6. **Screenshots on failure** — configure automatic screenshot capture
7. **Run serially for shared state** — `test.describe.serial` when tests depend on order

### Regression Suite Structure
```
e2e/
├── regression/           # Core user journeys (run every deploy)
│   ├── auth.spec.ts      # Login, logout, password reset
│   ├── core-workflow.spec.ts  # Primary business flow
│   └── navigation.spec.ts    # Key page accessibility
├── features/             # Feature-specific tests
│   ├── feature-a.spec.ts
│   └── feature-b.spec.ts
└── helpers/
    ├── fixtures.ts       # Shared test setup
    └── pages/            # Page objects
```

## Quality Gates

### PR Quality Gate
- [ ] All existing tests pass
- [ ] New code has tests (unit + integration where applicable)
- [ ] No decrease in coverage percentage
- [ ] No new lint warnings
- [ ] Build succeeds
- [ ] Type check passes

### Release Quality Gate
- [ ] Full regression suite passes
- [ ] E2E critical paths pass on staging
- [ ] Performance benchmarks within threshold
- [ ] Security scan clean (no critical/high)
- [ ] Accessibility audit passes (WCAG 2.1 AA)

### Acceptance Criteria Validation
Map each acceptance criterion to a test:
```
AC: "User can filter results by date range"
→ Unit test: filter function handles edge cases
→ Integration test: API returns filtered results
→ E2E test: user selects dates, table updates
```

## Flaky Test Mitigation
| Cause | Fix |
|-------|-----|
| Timing / race conditions | Explicit waits, retry assertions |
| Shared state between tests | Isolate test data, reset between runs |
| Network dependencies | Mock external services, use test doubles |
| Animation / transitions | Disable animations in test config |
| Date/time sensitivity | Mock `Date.now()`, use fixed timestamps |
| Order dependency | Each test stands alone, no `test.describe.serial` unless required |

## Test Naming Convention
```
describe('ModuleName', () => {
  it('should {expected behavior} when {condition}', () => {});
});

// Examples:
it('should return 401 when token is expired')
it('should create a new record when all fields are valid')
it('should throw ValidationError when email format is invalid')
```
