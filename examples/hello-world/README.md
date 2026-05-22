# Hello-World Example

This is a reference of what `setup.sh` produces after you onboard a product called **Hello World**.

It exists so you can see the post-substitution shape without running the wizard. Nothing here is wired into the runner — copy and adapt, don't symlink.

## What got generated

```
hello-world/
├── products/
│   └── hello-world/
│       └── product.json          ← product registration
└── hello-world-plugin/
    ├── PRODUCT.md                ← human-readable product brief
    └── agents/
        └── engineer-planner.md   ← one example agent (post-substitution)
```

A real run produces **14 agents** (every file in `templates/agents/`). Only one is shown here so you can diff it against the template.

## How substitution works

`setup.sh` reads each file in `templates/agents/`, runs:

```bash
sed \
  -e "s|__PRODUCT_NAME__|Hello World|g" \
  -e "s|__PRODUCT_ID__|hello-world|g" \
  -e "s|__PRODUCT_DESCRIPTION__|A minimal example product|g" \
  -e "s|__TECH_STACK__|Node.js, Express|g" \
  -e "s|__JIRA_PROJECT_KEY__|HELLO|g" \
  -e "s|__WORKING_DIR__|/Users/you/code/hello-world|g"
```

and writes the result into `<id>-plugin/agents/`. The copy is **idempotent** — re-running setup never clobbers an existing file, so once you've edited an agent it's yours.

## Compare against the template

```bash
diff -u templates/agents/engineer-planner.md examples/hello-world/hello-world-plugin/agents/engineer-planner.md
```

Every difference should be a substituted placeholder. No unresolved `__SOMETHING__` tokens should remain.

## Try it for real

Drop the wizard and onboard a product yourself:

```bash
./setup.sh
# choose "Add another product" if you already have one,
# or run on a fresh checkout for a first-run flow.
```
