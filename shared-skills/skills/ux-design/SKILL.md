---
name: ux-design
description: "UI/UX design intelligence with data-driven recommendations. Searchable databases covering 50+ styles, 161 colour palettes, 57 font pairings, 161 product types, 99 UX guidelines, and 25 chart types. 200+ individual design rules across 10 categories. Companion sub-skills: brand, design-system, design, slides, ui-styling, banner-design. Use for UI design specs, component design, accessibility reviews, design system generation, colour/typography selection, responsive design, or any task that changes how a feature looks, feels, moves, or is interacted with."
last_updated: 2026-03-29
---

# UI/UX Pro Max - Design Intelligence

Comprehensive design guide for web and mobile applications. Contains 50+ styles, 161 colour palettes, 57 font pairings, 161 product types with reasoning rules, 99 UX guidelines, and 25 chart types across 16 technology stacks. Searchable database with priority-based recommendations.

## Companion Sub-Skills

This is the core skill. It works with these companion skills (all in `shared-skills/skills/`):

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `brand` | Brand identity, voice, visual identity management | New product branding, brand consistency checks |
| `design-system` | Three-layer token architecture + slide generation | Design token setup, Tailwind config, slide decks |
| `design` | Unified design (logo, CIP, slides, banners, icons) | Logo creation, corporate identity, visual assets |
| `slides` | Strategic HTML presentations | Pitch decks, investor presentations, training slides |
| `ui-styling` | shadcn/ui + Tailwind CSS styling | Component styling, theme customisation, canvas design |
| `banner-design` | Multi-format banner creation | Marketing banners, social media assets |

---

## When to Apply

This Skill should be used when the task involves **UI structure, visual design decisions, interaction patterns, or user experience quality control**.

### Must Use
- Designing new pages (landing page, dashboard, admin panel, SaaS, mobile app)
- Creating or refactoring UI components (buttons, modals, forms, tables, charts)
- Choosing colour schemes, typography systems, spacing standards, or layout systems
- Reviewing UI code for user experience, accessibility, or visual consistency
- Implementing navigation structures, animations, or responsive behaviour
- Making product-level design decisions (style, information hierarchy, brand expression)
- Improving perceived quality, clarity, or usability of interfaces

### Recommended
- UI looks "not professional enough" but the reason is unclear
- Receiving feedback on usability or experience
- Pre-launch UI quality optimisation
- Aligning cross-platform design (Web / iOS / Android)
- Building design systems or reusable component libraries

### Skip
- Pure backend logic, API or database design
- Infrastructure or DevOps work
- Performance optimisation unrelated to the interface
- Non-visual scripts or automation tasks

**Decision criteria**: If the task will change how a feature **looks, feels, moves, or is interacted with**, use this skill.

---

## Master + Overrides Pattern

Each product plugin contains a `skills/ux-design/MASTER.md` file with the product's global design tokens (brand colours, typography scale, spacing, border radius, shadows, component defaults). Page-specific overrides live in `skills/ux-design/pages/<page-name>.md`.

**Retrieval order when building a page:**
1. Check `<product-plugin>/skills/ux-design/pages/<page-name>.md` — if it exists, its rules **override** the master
2. If no page override, use `<product-plugin>/skills/ux-design/MASTER.md` exclusively
3. Apply data-driven recommendations from the search scripts for any dimension not covered in MASTER.md

**Prompt template when building a specific page:**
```
I am building the [Page Name] page. Read MASTER.md from the product plugin skills/ux-design/.
Check if skills/ux-design/pages/[page-name].md exists.
If the page file exists, prioritise its rules. Otherwise use MASTER.md.
Then consult the shared ux-design skill scripts for any additional recommendations.
```

---

## Rule Categories by Priority

*Follow priority 1-10 to decide which rule category to focus on first; use `--domain <Domain>` to query details when needed.*

| Priority | Category | Impact | Domain | Key Checks | Anti-Patterns |
|----------|----------|--------|--------|------------|---------------|
| 1 | Accessibility | CRITICAL | `ux` | Contrast 4.5:1, Alt text, Keyboard nav, Aria-labels | Removing focus rings, Icon-only buttons without labels |
| 2 | Touch & Interaction | CRITICAL | `ux` | Min size 44x44px, 8px+ spacing, Loading feedback | Reliance on hover only, Instant state changes (0ms) |
| 3 | Performance | HIGH | `ux` | WebP/AVIF, Lazy loading, Reserve space (CLS < 0.1) | Layout thrashing, Cumulative Layout Shift |
| 4 | Style Selection | HIGH | `style`, `product` | Match product type, Consistency, SVG icons (no emoji) | Mixing flat & skeuomorphic randomly, Emoji as icons |
| 5 | Layout & Responsive | HIGH | `ux` | Mobile-first breakpoints, Viewport meta, No horizontal scroll | Horizontal scroll, Fixed px container widths, Disable zoom |
| 6 | Typography & Colour | MEDIUM | `typography`, `color` | Base 16px, Line-height 1.5, Semantic colour tokens | Text < 12px body, Gray-on-gray, Raw hex in components |
| 7 | Animation | MEDIUM | `ux` | Duration 150-300ms, Motion conveys meaning, Spatial continuity | Decorative-only animation, Animating width/height, No reduced-motion |
| 8 | Forms & Feedback | MEDIUM | `ux` | Visible labels, Error near field, Helper text, Progressive disclosure | Placeholder-only label, Errors only at top, Overwhelm upfront |
| 9 | Navigation Patterns | HIGH | `ux` | Predictable back, Deep linking, Hierarchy | Overloaded nav, Broken back behaviour, No deep links |
| 10 | Charts & Data | LOW | `chart` | Legends, Tooltips, Accessible colours | Relying on colour alone to convey meaning |

---

## Quick Reference

### 1. Accessibility (CRITICAL)

- `color-contrast` - Minimum 4.5:1 ratio for normal text (large text 3:1)
- `focus-states` - Visible focus rings on interactive elements (2-4px)
- `alt-text` - Descriptive alt text for meaningful images
- `aria-labels` - aria-label for icon-only buttons; accessibilityLabel in native
- `keyboard-nav` - Tab order matches visual order; full keyboard support
- `form-labels` - Use label with for attribute
- `skip-links` - Skip to main content for keyboard users
- `heading-hierarchy` - Sequential h1-h6, no level skip
- `color-not-only` - Don't convey info by colour alone (add icon/text)
- `dynamic-type` - Support system text scaling; avoid truncation as text grows
- `reduced-motion` - Respect prefers-reduced-motion; reduce/disable animations when requested
- `voiceover-sr` - Meaningful accessibilityLabel/accessibilityHint; logical reading order for VoiceOver/screen readers
- `escape-routes` - Provide cancel/back in modals and multi-step flows
- `keyboard-shortcuts` - Preserve system and a11y shortcuts; offer keyboard alternatives for drag-and-drop

### 2. Touch & Interaction (CRITICAL)

- `touch-target-size` - Min 44x44pt (Apple) / 48x48dp (Material); extend hit area beyond visual bounds if needed
- `touch-spacing` - Minimum 8px/8dp gap between touch targets
- `hover-vs-tap` - Use click/tap for primary interactions; don't rely on hover alone
- `loading-buttons` - Disable button during async operations; show spinner or progress
- `error-feedback` - Clear error messages near problem
- `cursor-pointer` - Add cursor-pointer to clickable elements (Web)
- `gesture-conflicts` - Avoid horizontal swipe on main content; prefer vertical scroll
- `tap-delay` - Use touch-action: manipulation to reduce 300ms delay (Web)
- `standard-gestures` - Use platform standard gestures consistently; don't redefine
- `system-gestures` - Don't block system gestures (Control Center, back swipe, etc.)
- `press-feedback` - Visual feedback on press (ripple/highlight; MD state layers)
- `haptic-feedback` - Use haptic for confirmations and important actions; avoid overuse
- `gesture-alternative` - Don't rely on gesture-only interactions; always provide visible controls for critical actions
- `safe-area-awareness` - Keep primary touch targets away from notch, Dynamic Island, gesture bar and screen edges
- `no-precision-required` - Avoid requiring pixel-perfect taps on small icons or thin edges
- `swipe-clarity` - Swipe actions must show clear affordance or hint (chevron, label, tutorial)
- `drag-threshold` - Use a movement threshold before starting drag to avoid accidental drags

### 3. Performance (HIGH)

- `image-optimization` - Use WebP/AVIF, responsive images (srcset/sizes), lazy load non-critical assets
- `image-dimension` - Declare width/height or use aspect-ratio to prevent layout shift (CLS)
- `font-loading` - Use font-display: swap/optional to avoid invisible text (FOIT); reserve space to reduce layout shift
- `font-preload` - Preload only critical fonts; avoid overusing preload on every variant
- `critical-css` - Prioritise above-the-fold CSS (inline critical CSS or early-loaded stylesheet)
- `lazy-loading` - Lazy load non-hero components via dynamic import / route-level splitting
- `bundle-splitting` - Split code by route/feature (React Suspense / Next.js dynamic) to reduce initial load and TTI
- `third-party-scripts` - Load third-party scripts async/defer; audit and remove unnecessary ones
- `reduce-reflows` - Avoid frequent layout reads/writes; batch DOM reads then writes
- `content-jumping` - Reserve space for async content to avoid layout jumps (CLS)
- `lazy-load-below-fold` - Use loading="lazy" for below-the-fold images and heavy media
- `virtualize-lists` - Virtualise lists with 50+ items to improve memory efficiency and scroll performance
- `main-thread-budget` - Keep per-frame work under ~16ms for 60fps; move heavy tasks off main thread
- `progressive-loading` - Use skeleton screens / shimmer instead of long blocking spinners for >1s operations
- `input-latency` - Keep input latency under ~100ms for taps/scrolls
- `tap-feedback-speed` - Provide visual feedback within 100ms of tap
- `debounce-throttle` - Use debounce/throttle for high-frequency events (scroll, resize, input)
- `offline-support` - Provide offline state messaging and basic fallback (PWA / mobile)
- `network-fallback` - Offer degraded modes for slow networks (lower-res images, fewer animations)

### 4. Style Selection (HIGH)

- `style-match` - Match style to product type (use `--design-system` for recommendations)
- `consistency` - Use same style across all pages
- `no-emoji-icons` - Use SVG icons (Heroicons, Lucide), not emojis
- `color-palette-from-product` - Choose palette from product/industry (search `--domain color`)
- `effects-match-style` - Shadows, blur, radius aligned with chosen style (glass / flat / clay etc.)
- `platform-adaptive` - Respect platform idioms (iOS HIG vs Material): navigation, controls, typography, motion
- `state-clarity` - Make hover/pressed/disabled states visually distinct while staying on-style
- `elevation-consistent` - Use a consistent elevation/shadow scale for cards, sheets, modals; avoid random shadow values
- `dark-mode-pairing` - Design light/dark variants together to keep brand, contrast, and style consistent
- `icon-style-consistent` - Use one icon set/visual language (stroke width, corner radius) across the product
- `system-controls` - Prefer native/system controls over fully custom ones; only customise when branding requires it
- `blur-purpose` - Use blur to indicate background dismissal (modals, sheets), not as decoration
- `primary-action` - Each screen should have only one primary CTA; secondary actions visually subordinate

### 5. Layout & Responsive (HIGH)

- `viewport-meta` - width=device-width initial-scale=1 (never disable zoom)
- `mobile-first` - Design mobile-first, then scale up to tablet and desktop
- `breakpoint-consistency` - Use systematic breakpoints (e.g. 375 / 768 / 1024 / 1440)
- `readable-font-size` - Minimum 16px body text on mobile (avoids iOS auto-zoom)
- `line-length-control` - Mobile 35-60 chars per line; desktop 60-75 chars
- `horizontal-scroll` - No horizontal scroll on mobile; ensure content fits viewport width
- `spacing-scale` - Use 4pt/8dp incremental spacing system
- `touch-density` - Keep component spacing comfortable for touch: not cramped, not causing mis-taps
- `container-width` - Consistent max-width on desktop (max-w-6xl / 7xl)
- `z-index-management` - Define layered z-index scale (e.g. 0 / 10 / 20 / 40 / 100 / 1000)
- `fixed-element-offset` - Fixed navbar/bottom bar must reserve safe padding for underlying content
- `scroll-behavior` - Avoid nested scroll regions that interfere with the main scroll experience
- `viewport-units` - Prefer min-h-dvh over 100vh on mobile
- `orientation-support` - Keep layout readable and operable in landscape mode
- `content-priority` - Show core content first on mobile; fold or hide secondary content
- `visual-hierarchy` - Establish hierarchy via size, spacing, contrast — not colour alone

### 6. Typography & Colour (MEDIUM)

- `line-height` - Use 1.5-1.75 for body text
- `line-length` - Limit to 65-75 characters per line
- `font-pairing` - Match heading/body font personalities
- `font-scale` - Consistent type scale (e.g. 12 14 16 18 24 32)
- `contrast-readability` - Darker text on light backgrounds (e.g. slate-900 on white)
- `text-styles-system` - Use platform type system: Dynamic Type styles / Material type roles (display, headline, title, body, label)
- `weight-hierarchy` - Use font-weight to reinforce hierarchy: Bold headings (600-700), Regular body (400), Medium labels (500)
- `color-semantic` - Define semantic colour tokens (primary, secondary, error, surface, on-surface) not raw hex in components
- `color-dark-mode` - Dark mode uses desaturated / lighter tonal variants, not inverted colours; test contrast separately
- `color-accessible-pairs` - Foreground/background pairs must meet 4.5:1 (AA) or 7:1 (AAA); use tools to verify
- `color-not-decorative-only` - Functional colour (error red, success green) must include icon/text; avoid colour-only meaning
- `truncation-strategy` - Prefer wrapping over truncation; when truncating use ellipsis and provide full text via tooltip/expand
- `letter-spacing` - Respect default letter-spacing per platform; avoid tight tracking on body text
- `number-tabular` - Use tabular/monospaced figures for data columns, prices, and timers to prevent layout shift
- `whitespace-balance` - Use whitespace intentionally to group related items and separate sections; avoid visual clutter

### 7. Animation (MEDIUM)

- `duration-timing` - Use 150-300ms for micro-interactions; complex transitions <=400ms; avoid >500ms
- `transform-performance` - Use transform/opacity only; avoid animating width/height/top/left
- `loading-states` - Show skeleton or progress indicator when loading exceeds 300ms
- `excessive-motion` - Animate 1-2 key elements per view max
- `easing` - Use ease-out for entering, ease-in for exiting; avoid linear for UI transitions
- `motion-meaning` - Every animation must express a cause-effect relationship, not just be decorative
- `state-transition` - State changes (hover / active / expanded / collapsed / modal) should animate smoothly, not snap
- `continuity` - Page/screen transitions should maintain spatial continuity (shared element, directional slide)
- `parallax-subtle` - Use parallax sparingly; must respect reduced-motion and not cause disorientation
- `spring-physics` - Prefer spring/physics-based curves over linear or cubic-bezier for natural feel
- `exit-faster-than-enter` - Exit animations shorter than enter (~60-70% of enter duration) to feel responsive
- `stagger-sequence` - Stagger list/grid item entrance by 30-50ms per item; avoid all-at-once or too-slow reveals
- `shared-element-transition` - Use shared element / hero transitions for visual continuity between screens
- `interruptible` - Animations must be interruptible; user tap/gesture cancels in-progress animation immediately
- `no-blocking-animation` - Never block user input during an animation; UI must stay interactive
- `fade-crossfade` - Use crossfade for content replacement within the same container
- `scale-feedback` - Subtle scale (0.95-1.05) on press for tappable cards/buttons; restore on release
- `gesture-feedback` - Drag, swipe, and pinch must provide real-time visual response tracking the finger
- `hierarchy-motion` - Use translate/scale direction to express hierarchy: enter from below = deeper, exit upward = back
- `motion-consistency` - Unify duration/easing tokens globally; all animations share the same rhythm and feel
- `opacity-threshold` - Fading elements should not linger below opacity 0.2; either fade fully or remain visible
- `modal-motion` - Modals/sheets should animate from their trigger source (scale+fade or slide-in) for spatial context
- `navigation-direction` - Forward navigation animates left/up; backward animates right/down — keep direction logically consistent
- `layout-shift-avoid` - Animations must not cause layout reflow or CLS; use transform for position changes

### 8. Forms & Feedback (MEDIUM)

- `input-labels` - Visible label per input (not placeholder-only)
- `error-placement` - Show error below the related field
- `submit-feedback` - Loading then success/error state on submit
- `required-indicators` - Mark required fields (e.g. asterisk)
- `empty-states` - Helpful message and action when no content
- `toast-dismiss` - Auto-dismiss toasts in 3-5s
- `confirmation-dialogs` - Confirm before destructive actions
- `input-helper-text` - Provide persistent helper text below complex inputs, not just placeholder
- `disabled-states` - Disabled elements use reduced opacity (0.38-0.5) + cursor change + semantic attribute
- `progressive-disclosure` - Reveal complex options progressively; don't overwhelm users upfront
- `inline-validation` - Validate on blur (not keystroke); show error only after user finishes input
- `input-type-keyboard` - Use semantic input types (email, tel, number) to trigger the correct mobile keyboard
- `password-toggle` - Provide show/hide toggle for password fields
- `autofill-support` - Use autocomplete / textContentType attributes so the system can autofill
- `undo-support` - Allow undo for destructive or bulk actions (e.g. "Undo delete" toast)
- `success-feedback` - Confirm completed actions with brief visual feedback (checkmark, toast, colour flash)
- `error-recovery` - Error messages must include a clear recovery path (retry, edit, help link)
- `multi-step-progress` - Multi-step flows show step indicator or progress bar; allow back navigation
- `form-autosave` - Long forms should auto-save drafts to prevent data loss on accidental dismissal
- `sheet-dismiss-confirm` - Confirm before dismissing a sheet/modal with unsaved changes
- `error-clarity` - Error messages must state cause + how to fix (not just "Invalid input")
- `field-grouping` - Group related fields logically (fieldset/legend or visual grouping)
- `read-only-distinction` - Read-only state should be visually and semantically different from disabled
- `focus-management` - After submit error, auto-focus the first invalid field
- `error-summary` - For multiple errors, show summary at top with anchor links to each field
- `touch-friendly-input` - Mobile input height >=44px to meet touch target requirements
- `destructive-emphasis` - Destructive actions use semantic danger colour (red) and are visually separated from primary actions
- `toast-accessibility` - Toasts must not steal focus; use aria-live="polite" for screen reader announcement
- `aria-live-errors` - Form errors use aria-live region or role="alert" to notify screen readers
- `contrast-feedback` - Error and success state colours must meet 4.5:1 contrast ratio
- `timeout-feedback` - Request timeout must show clear feedback with retry option

### 9. Navigation Patterns (HIGH)

- `bottom-nav-limit` - Bottom navigation max 5 items; use labels with icons
- `drawer-usage` - Use drawer/sidebar for secondary navigation, not primary actions
- `back-behavior` - Back navigation must be predictable and consistent; preserve scroll/state
- `deep-linking` - All key screens must be reachable via deep link / URL for sharing and notifications
- `tab-bar-ios` - iOS: use bottom Tab Bar for top-level navigation
- `top-app-bar-android` - Android: use Top App Bar with navigation icon for primary structure
- `nav-label-icon` - Navigation items must have both icon and text label; icon-only nav harms discoverability
- `nav-state-active` - Current location must be visually highlighted (colour, weight, indicator) in navigation
- `nav-hierarchy` - Primary nav (tabs/bottom bar) vs secondary nav (drawer/settings) must be clearly separated
- `modal-escape` - Modals and sheets must offer a clear close/dismiss affordance; swipe-down to dismiss on mobile
- `search-accessible` - Search must be easily reachable (top bar or tab); provide recent/suggested queries
- `breadcrumb-web` - Web: use breadcrumbs for 3+ level deep hierarchies to aid orientation
- `state-preservation` - Navigating back must restore previous scroll position, filter state, and input
- `gesture-nav-support` - Support system gesture navigation (iOS swipe-back, Android predictive back) without conflict
- `tab-badge` - Use badges on nav items sparingly to indicate unread/pending; clear after user visits
- `overflow-menu` - When actions exceed available space, use overflow/more menu instead of cramming
- `bottom-nav-top-level` - Bottom nav is for top-level screens only; never nest sub-navigation inside it
- `adaptive-navigation` - Large screens (>=1024px) prefer sidebar; small screens use bottom/top nav
- `back-stack-integrity` - Never silently reset the navigation stack or unexpectedly jump to home
- `navigation-consistency` - Navigation placement must stay the same across all pages; don't change by page type
- `avoid-mixed-patterns` - Don't mix Tab + Sidebar + Bottom Nav at the same hierarchy level
- `modal-vs-navigation` - Modals must not be used for primary navigation flows; they break the user's path
- `focus-on-route-change` - After page transition, move focus to main content region for screen reader users
- `persistent-nav` - Core navigation must remain reachable from deep pages; don't hide it entirely in sub-flows
- `destructive-nav-separation` - Dangerous actions (delete account, logout) must be visually and spatially separated from normal nav items
- `empty-nav-state` - When a nav destination is unavailable, explain why instead of silently hiding it

### 10. Charts & Data (LOW)

- `chart-type` - Match chart type to data type (trend -> line, comparison -> bar, proportion -> pie/donut)
- `color-guidance` - Use accessible colour palettes; avoid red/green only pairs for colourblind users
- `data-table` - Provide table alternative for accessibility; charts alone are not screen-reader friendly
- `pattern-texture` - Supplement colour with patterns, textures, or shapes so data is distinguishable without colour
- `legend-visible` - Always show legend; position near the chart, not detached below a scroll fold
- `tooltip-on-interact` - Provide tooltips/data labels on hover (Web) or tap (mobile) showing exact values
- `axis-labels` - Label axes with units and readable scale; avoid truncated or rotated labels on mobile
- `responsive-chart` - Charts must reflow or simplify on small screens (e.g. horizontal bar instead of vertical, fewer ticks)
- `empty-data-state` - Show meaningful empty state when no data exists ("No data yet" + guidance), not a blank chart
- `loading-chart` - Use skeleton or shimmer placeholder while chart data loads; don't show an empty axis frame
- `animation-optional` - Chart entrance animations must respect prefers-reduced-motion; data should be readable immediately
- `large-dataset` - For 1000+ data points, aggregate or sample; provide drill-down for detail instead of rendering all
- `number-formatting` - Use locale-aware formatting for numbers, dates, currencies on axes and labels
- `touch-target-chart` - Interactive chart elements (points, segments) must have >=44pt tap area or expand on touch
- `no-pie-overuse` - Avoid pie/donut for >5 categories; switch to bar chart for clarity
- `contrast-data` - Data lines/bars vs background >=3:1; data text labels >=4.5:1
- `legend-interactive` - Legends should be clickable to toggle series visibility
- `direct-labeling` - For small datasets, label values directly on the chart to reduce eye travel
- `tooltip-keyboard` - Tooltip content must be keyboard-reachable and not rely on hover alone
- `sortable-table` - Data tables must support sorting with aria-sort indicating current sort state
- `axis-readability` - Axis ticks must not be cramped; maintain readable spacing, auto-skip on small screens
- `data-density` - Limit information density per chart to avoid cognitive overload; split into multiple charts if needed
- `trend-emphasis` - Emphasise data trends over decoration; avoid heavy gradients/shadows that obscure the data
- `gridline-subtle` - Grid lines should be low-contrast (e.g. gray-200) so they don't compete with data
- `focusable-elements` - Interactive chart elements (points, bars, slices) must be keyboard-navigable
- `screen-reader-summary` - Provide a text summary or aria-label describing the chart's key insight for screen readers
- `error-state-chart` - Data load failure must show error message with retry action, not a broken/empty chart
- `export-option` - For data-heavy products, offer CSV/image export of chart data
- `drill-down-consistency` - Drill-down interactions must maintain a clear back-path and hierarchy breadcrumb
- `time-scale-clarity` - Time series charts must clearly label time granularity (day/week/month) and allow switching

---

## How to Use This Skill

| Scenario | Trigger Examples | Start From |
|----------|-----------------|------------|
| **New project / page** | "Build a landing page", "Build a dashboard" | Step 1 -> Step 2 (design system) |
| **New component** | "Create a pricing card", "Add a modal" | Step 3 (domain search: style, ux) |
| **Choose style / colour / font** | "What style fits a fintech app?", "Recommend a colour palette" | Step 2 (design system) |
| **Review existing UI** | "Review this page for UX issues", "Check accessibility" | Quick Reference checklist above |
| **Fix a UI bug** | "Button hover is broken", "Layout shifts on load" | Quick Reference -> relevant section |
| **Improve / optimise** | "Make this faster", "Improve mobile experience" | Step 3 (domain search: ux, react) |
| **Implement dark mode** | "Add dark mode support" | Step 3 (domain: style "dark mode") |
| **Add charts / data viz** | "Add an analytics dashboard chart" | Step 3 (domain: chart) |
| **Stack best practices** | "React performance tips", "Next.js navigation" | Step 4 (stack search) |

### Step 1: Analyse User Requirements

Extract key information from user request:
- **Product type**: SaaS, e-commerce, dashboard, admin, legal, compliance, warranty, etc.
- **Target audience**: B2B professionals, consumers, internal staff
- **Style keywords**: professional, clean, modern, dark mode, etc.
- **Stack**: React + Next.js (primary for all products)

### Step 2: Generate Design System (REQUIRED for new pages/projects)

**Always start with `--design-system`** to get comprehensive recommendations with reasoning:

```bash
python3 shared-skills/skills/ux-design/scripts/search.py "<product_type> <industry> <keywords>" --design-system [-p "Project Name"]
```

This command:
1. Searches domains in parallel (product, style, colour, landing, typography)
2. Applies reasoning rules from `ui-reasoning.csv` to select best matches
3. Returns complete design system: pattern, style, colours, typography, effects
4. Includes anti-patterns to avoid

**Examples per product:**
```bash
# OrchestraCode
python3 shared-skills/skills/ux-design/scripts/search.py "compliance SaaS dashboard B2B security professional" --design-system -p "OrchestraCode"

# EstateOS
python3 shared-skills/skills/ux-design/scripts/search.py "legal SaaS estate planning professional UK trust" --design-system -p "EstateOS"

# WarrantyManagement
python3 shared-skills/skills/ux-design/scripts/search.py "warranty admin B2B vehicle claims professional" --design-system -p "WarrantyManagement"
```

### Step 2b: Persist Design System (Master + Overrides)

To save the design system for hierarchical retrieval across sessions, add `--persist`:

```bash
python3 shared-skills/skills/ux-design/scripts/search.py "<query>" --design-system --persist -p "Project Name" --output-dir <product-plugin>/skills/ux-design
```

This creates/updates:
- `<output-dir>/MASTER.md` — Global Source of Truth with all design rules
- `<output-dir>/pages/` — Folder for page-specific overrides

**With page-specific override:**
```bash
python3 shared-skills/skills/ux-design/scripts/search.py "<query>" --design-system --persist -p "OrchestraCode" --page "dashboard" --output-dir orchestracode-plugin/skills/ux-design
```

### Step 3: Domain Searches (supplement as needed)

After generating the design system, use domain searches to get additional detail on specific dimensions:

```bash
python3 shared-skills/skills/ux-design/scripts/search.py "<keyword>" --domain <domain> [-n <max_results>]
```

| Need | Domain | Example Query |
|------|--------|---------------|
| Product type patterns | `product` | `"compliance SaaS B2B"` |
| UI style options | `style` | `"glassmorphism dark mode"` |
| Colour palettes | `color` | `"fintech trust professional"` |
| Font pairings | `typography` | `"professional modern clean"` |
| Chart recommendations | `chart` | `"real-time dashboard trend"` |
| UX best practices | `ux` | `"animation accessibility loading"` |
| Google Fonts lookup | `google-fonts` | `"sans serif variable popular"` |
| Landing page structure | `landing` | `"hero social-proof CTA"` |
| React/Next.js performance | `react` | `"suspense memo rerender bundle"` |
| Web a11y & interface | `web` | `"aria focus outline semantic"` |

### Step 4: Stack-Specific Guidelines

Our primary stack is React + Next.js. Get implementation-specific guidance:

```bash
python3 shared-skills/skills/ux-design/scripts/search.py "<keyword>" --stack nextjs
python3 shared-skills/skills/ux-design/scripts/search.py "<keyword>" --stack react
python3 shared-skills/skills/ux-design/scripts/search.py "<keyword>" --stack shadcn
```

Available stacks: `react`, `nextjs`, `vue`, `svelte`, `astro`, `swiftui`, `react-native`, `flutter`, `nuxtjs`, `nuxt-ui`, `html-tailwind`, `shadcn`, `jetpack-compose`, `threejs`, `angular`, `laravel`

---

## Search Reference

### Available Domains

| Domain | Use For | Example Keywords |
|--------|---------|------------------|
| `product` | Product type recommendations | SaaS, e-commerce, portfolio, healthcare, compliance |
| `style` | UI styles, colours, effects | glassmorphism, minimalism, dark mode, brutalism |
| `typography` | Font pairings, Google Fonts | elegant, playful, professional, modern |
| `color` | Colour palettes by product type | saas, ecommerce, healthcare, fintech, legal |
| `landing` | Page structure, CTA strategies | hero, hero-centric, testimonial, pricing, social-proof |
| `chart` | Chart types, library recommendations | trend, comparison, timeline, funnel, pie |
| `ux` | Best practices, anti-patterns | animation, accessibility, z-index, loading |
| `google-fonts` | Individual Google Fonts lookup | sans serif, monospace, variable font, popular |
| `react` | React/Next.js performance | waterfall, bundle, suspense, memo, rerender, cache |
| `web` | App interface guidelines | accessibilityLabel, touch targets, safe areas |
| `prompt` | AI prompts, CSS keywords | (style name) |

---

## Output Formats

The `--design-system` flag supports two output formats:

```bash
# ASCII box (default) - best for terminal display
python3 shared-skills/skills/ux-design/scripts/search.py "fintech crypto" --design-system

# Markdown - best for documentation
python3 shared-skills/skills/ux-design/scripts/search.py "fintech crypto" --design-system -f markdown
```

---

## Common Sticking Points

| Problem | What to Do |
|---------|------------|
| Can't decide on style/colour | Re-run `--design-system` with different keywords |
| Dark mode contrast issues | Quick Reference S6: `color-dark-mode` + `color-accessible-pairs` |
| Animations feel unnatural | Quick Reference S7: `spring-physics` + `easing` + `exit-faster-than-enter` |
| Form UX is poor | Quick Reference S8: `inline-validation` + `error-clarity` + `focus-management` |
| Navigation feels confusing | Quick Reference S9: `nav-hierarchy` + `back-behavior` + `deep-linking` |
| Layout breaks on small screens | Quick Reference S5: `mobile-first` + `breakpoint-consistency` |
| Performance / jank | Quick Reference S3: `virtualize-lists` + `main-thread-budget` + `debounce-throttle` |
| Chart not accessible | Quick Reference S10: `data-table` + `pattern-texture` + `screen-reader-summary` |

---

## Common Rules for Professional UI

These are frequently overlooked issues that make UI look unprofessional:

### Icons & Visual Elements

| Rule | Standard | Avoid |
|------|----------|-------|
| **No Emoji as Icons** | Use vector-based icons (Lucide, Heroicons) | Using emojis for navigation, settings, or system controls |
| **Vector-Only Assets** | Use SVG icons that scale cleanly and support theming | Raster PNG icons that blur or pixelate |
| **Stable Interaction States** | Use colour, opacity, or elevation transitions for press states | Layout-shifting transforms that move surrounding content |
| **Correct Brand Logos** | Use official brand assets with correct proportions and clear space | Guessing logo paths, recolouring unofficially |
| **Consistent Icon Sizing** | Define icon sizes as design tokens (icon-sm, icon-md = 20px, icon-lg) | Mixing arbitrary values randomly |
| **Stroke Consistency** | Use consistent stroke width (e.g. 1.5px for Lucide) | Mixing thick and thin stroke styles |
| **Touch Target Minimum** | Minimum 44x44px interactive area | Small icons without expanded tap area |

### Light/Dark Mode Contrast

| Rule | Do | Don't |
|------|----|----- |
| **Surface readability** | Keep cards/surfaces clearly separated from background | Overly transparent surfaces that blur hierarchy |
| **Text contrast (light)** | Maintain body text contrast >=4.5:1 against light surfaces | Low-contrast grey body text |
| **Text contrast (dark)** | Maintain primary text contrast >=4.5:1 on dark surfaces | Dark mode text that blends into background |
| **Token-driven theming** | Use semantic colour tokens mapped per theme | Hardcoded per-screen hex values |

---

## Pre-Delivery Checklist

Before delivering UI code, verify these items:

### Visual Quality
- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons come from a consistent icon family and style (Lucide React)
- [ ] Semantic theme tokens are used consistently (no ad-hoc hardcoded colours)
- [ ] MASTER.md design tokens applied throughout

### Accessibility
- [ ] Colour contrast: 4.5:1 for normal text, 3:1 for large text
- [ ] Focus indicators: Visible focus ring on all interactive elements
- [ ] Keyboard navigation: All actions reachable via Tab/Enter/Space/Escape
- [ ] Alt text: All meaningful images have descriptive alt text
- [ ] Form labels: Every input has an associated `<label>`
- [ ] Heading hierarchy: h1 -> h2 -> h3 (no skipping levels)
- [ ] Colour not the only signal: Errors/status also use icons or text labels
- [ ] Reduced motion: `prefers-reduced-motion` respected

### Interaction
- [ ] Touch targets: minimum 44x44px on mobile
- [ ] cursor-pointer on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Loading states for all async operations >300ms
- [ ] Empty states for all lists/data views
- [ ] Error states linked to form fields via aria-describedby

### Layout
- [ ] Responsive tested at 375px, 768px, 1024px, 1440px
- [ ] No horizontal scroll on mobile
- [ ] next/image for all images, next/font for all fonts
- [ ] Dark mode contrast verified independently (if applicable)

### Next.js Specifics
- [ ] Server Components by default; `'use client'` only for interactivity
- [ ] `next/image` for all images (automatic WebP, lazy loading)
- [ ] `next/font` for fonts (eliminates FOIT/FOUT)
- [ ] `loading.tsx` + Suspense boundaries for progressive loading
- [ ] Dynamic imports for heavy components below the fold
