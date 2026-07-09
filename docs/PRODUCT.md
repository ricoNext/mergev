# Mergev Product Plan

## One-Line Introduction

Mergev is a terminal Git merge conflict resolver with a three-pane visual workflow, helping developers review, choose, edit, validate, and finish conflicted merges without leaving the command line.

## Chinese Introduction

Mergev 是一个在命令行里提供三栏可视化流程的 Git 冲突解决工具，让开发者像在 WebStorm 里一样逐块选择、编辑并校验最终合并结果。

## Product Positioning

Mergev focuses on one painful workflow: resolving Git conflicts. It brings the core WebStorm merge dialog experience into a terminal UI:

- Three-pane visual merge view
- Conflict-by-conflict navigation
- Accept ours, theirs, both, or manual result
- Live result preview
- Validation before marking a file as resolved
- Git flow awareness for merge, rebase, and cherry-pick

The goal is not to replace a full IDE. The goal is to make conflict resolution fast, visible, and reliable for developers who work primarily in the terminal.

## Target Users

- Developers who prefer terminal-first Git workflows
- Developers who like WebStorm or VS Code merge editors but do not want to leave the command line
- Maintainers who frequently resolve conflicts during rebases, cherry-picks, and dependency updates
- Teams that want a repeatable conflict-resolution workflow with validation commands
- AI coding agent users who need a structured and inspectable merge result before continuing

## Core Problem

Git's built-in conflict format is powerful but not friendly:

```text
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch
```

This format makes the developer manually answer several questions:

- Which side is ours and which side is theirs?
- What will the final file look like?
- Which conflicts are still unresolved?
- Did Git auto-merge nearby code that is textually valid but semantically risky?
- Is the result syntactically valid?
- What command should be run next: commit, rebase continue, or cherry-pick continue?

Mergev turns those questions into an interactive workflow.

## Design Inspiration

Mergev is inspired by WebStorm's conflict resolution workflow:

- The developer opens a conflict file from a conflict list.
- The tool shows the current branch, incoming branch, and final result.
- The developer resolves one conflict block at a time.
- The final result is always visible and editable.
- The tool validates the result and helps finish the Git operation.

## MVP Scope

The first version should complete a narrow but real workflow:

> Detect conflicted files, open a three-pane terminal merge view, let users resolve each conflict by accepting ours/theirs/both/manual, write the final result, validate it, and mark the file as resolved.

### 1. Git Repository Detection

Mergev should:

- Detect whether the current directory is inside a Git repository
- Find the repository root
- Read the current Git operation state
- Show a clear error when not inside a Git repository

Relevant Git states:

- Normal merge conflict
- Rebase conflict
- Cherry-pick conflict
- Revert conflict

### 2. Conflicted File Discovery

Mergev should list unmerged files from Git.

For each file, show:

- Path
- Conflict status
- Number of detected conflict blocks
- File type or extension
- Whether the file has already been resolved in the current session

Example:

```text
Conflicted files

> src/user.ts          3 conflicts   TypeScript
  package.json         1 conflict    JSON
  pnpm-lock.yaml       1 conflict    lockfile
```

### 3. Read Git Three-Way Versions

Mergev should read the three staged versions from Git's index:

```bash
git show :1:path   # base
git show :2:path   # ours
git show :3:path   # theirs
```

This is more reliable than only parsing conflict markers from the working tree.

Mergev should maintain:

- Base content
- Ours content
- Theirs content
- Current result content
- Conflict block metadata
- User decisions for each conflict block

### 4. Three-Pane Terminal UI

The main file view should support a WebStorm-like layout:

```text
+----------------------+----------------------+----------------------+
| Ours                 | Result               | Theirs               |
| current branch       | final file           | incoming branch      |
+----------------------+----------------------+----------------------+
| ...                  | ...                  | ...                  |
| highlighted conflict | editable result      | highlighted conflict |
| ...                  | ...                  | ...                  |
+----------------------+----------------------+----------------------+
| src/user.ts  Conflict 2/7  unresolved: 5  check: passing           |
| h ours  l theirs  b both  e edit  n next  p prev  s save  ? help   |
+--------------------------------------------------------------------+
```

The layout should adapt to terminal width:

- Wide terminal: three-pane mode
- Medium terminal: two-pane mode
- Narrow terminal: single-pane result-focused mode

### 5. Conflict Navigation

Users should be able to move through conflicts without searching manually.

Required actions:

- Next conflict
- Previous conflict
- Jump to first unresolved conflict
- Jump between files
- Show current conflict index
- Show unresolved count

Suggested shortcuts:

```text
n    next conflict
p    previous conflict
f    file list
g    first unresolved conflict
?    help
```

### 6. Accept Changes

For each conflict block, users should be able to:

- Accept ours
- Accept theirs
- Accept both
- Edit manually
- Reset the block to unresolved
- Undo the last decision

Suggested shortcuts:

```text
h    accept ours
l    accept theirs
b    accept both
e    edit result
u    undo
r    reset current conflict
```

The result pane should update immediately after each decision.

### 7. Result Preview

The result pane is the source of truth for the final working tree file.

It should show:

- Resolved conflict content
- Unresolved conflict placeholders
- Manual edits
- Highlighted changed lines
- Validation diagnostics when available

The user should always understand what will be written to disk.

### 8. Save and Mark Resolved

When a file has no unresolved conflict blocks, Mergev should allow saving.

Save flow:

1. Write result content to the working tree file
2. Check that conflict markers are gone
3. Run file-level validation
4. Optionally run a configured command
5. Run `git add path` unless disabled by option
6. Update the file list state

Suggested commands:

```bash
mergev
mergev src/user.ts
mergev --no-add
```

### 9. Basic Validation

MVP validation should include:

- No remaining conflict markers
- JSON parse validation for `.json`
- YAML parse validation for `.yaml` / `.yml`
- Basic JavaScript / TypeScript parse validation when supported

Validation output should be short and actionable:

```text
check: failed
src/user.ts:42: Unexpected token
```

### 10. Git Flow Completion

After all conflicts are resolved, Mergev should detect the active Git flow and suggest the next command:

- Merge: commit the merge
- Rebase: `git rebase --continue`
- Cherry-pick: `git cherry-pick --continue`
- Revert: `git revert --continue`

Mergev may provide a confirmable action to continue the flow in a later version.

## Better-Than-MVP Features

These features make Mergev feel polished and useful in real projects.

### 1. Non-Conflicting Change Review

Git can auto-merge some changes successfully. Those changes may still be semantically risky.

Mergev should show nearby non-conflicting changes and allow users to review them before saving.

Possible actions:

- Show/hide non-conflicting changes
- Apply all non-conflicting changes
- Highlight changed context around conflicts

### 2. Inline Diff

Mergev should support both line-level and word-level diff highlighting.

Useful examples:

- Variable rename
- Function argument change
- String change
- Conditional expression change
- Import path change

### 3. Manual Editing

Manual editing should be possible when a conflict cannot be solved by choosing one side.

Possible approaches:

- Edit the current result block inside the TUI
- Open `$EDITOR` for the current block or whole result file
- Refresh the TUI after editor exit
- Re-run validation after edit

MVP can start with external editor support.

### 4. Custom Check Command

Users should be able to run project-specific checks:

```bash
mergev --check "pnpm typecheck"
mergev --check "pnpm test"
mergev --check "npm run lint"
```

Config support can come later.

### 5. Configuration File

Mergev should eventually support a config file:

```json
{
  "check": "pnpm typecheck",
  "autoAdd": true,
  "lockfileStrategy": "regenerate",
  "keymap": "default"
}
```

Possible config locations:

- `.mergev.json`
- `.mergevrc`
- `package.json` field: `mergev`

### 6. Session Recovery

Large rebases can take time. Users may quit and resume later.

Mergev should persist:

- Current file
- Current conflict index
- Decisions made in the current session
- Unsaved result content

Session state should be stored in a Git-ignored location.

### 7. Safe Undo and Backup

Before writing files, Mergev should protect user work.

Possible safety features:

- In-memory undo stack
- Before-save backup
- Restore previous result
- Show changed files before exiting

## Differentiated Features

These features can make Mergev more than a terminal clone of an IDE merge editor.

### 1. File-Type-Aware Conflict Handling

Mergev can provide smarter views for common file types.

#### JSON

- Show object paths
- Detect duplicate keys
- Validate parse result
- Sort or preserve key order depending on config

#### JavaScript / TypeScript

- Group conflicts by function, class, import block, or export
- Detect duplicate imports
- Parse result before saving
- Surface syntax diagnostics near the result pane

#### Markdown

- Resolve by paragraph or heading section
- Preserve surrounding prose

#### CSS / SCSS

- Group by selector
- Detect duplicate declarations

#### Lockfiles

- Warn that manual conflict resolution may be risky
- Suggest regenerating lockfile when appropriate
- Allow file-level accept ours/theirs when user confirms

### 2. Semantic Suggestions

Mergev may provide rule-based suggestions before any AI feature:

- Both sides add imports: merge and deduplicate
- Both sides add array items: combine if order is safe
- JSON object changes: merge by key when keys are distinct
- Package scripts conflict: require manual review

All suggestions must be confirmable. Mergev should never silently make risky semantic decisions.

### 3. Optional AI Assistance

AI support should be optional and later-stage.

Possible capabilities:

- Explain the conflict
- Suggest a merged result
- Identify likely semantic risks
- Generate a summary of the resolved file

Important constraints:

- AI output is only a suggestion
- User confirmation is required
- The result must still pass validation
- Local privacy and opt-in behavior must be clear

## CLI Design

### Basic Commands

```bash
mergev
mergev src/user.ts
mergev --check "pnpm test"
mergev --no-add
mergev --list
```

### Future Commands

```bash
mergev continue
mergev abort
mergev status
mergev config init
mergev doctor
```

### Suggested Options

```text
--check <command>    run a command before finishing
--no-add             do not run git add after save
--all                walk through all conflicted files
--mode <mode>        force layout: three-pane, two-pane, result
--editor <command>   choose editor for manual edits
--no-session         disable session persistence
--debug              show debug information
```

## Keyboard Model

Initial keymap:

```text
n    next conflict
p    previous conflict
h    accept ours
l    accept theirs
b    accept both
e    edit result
u    undo
r    reset conflict
s    save file
a    save and git add
f    file list
c    run check
q    quit
?    help
```

The keymap should be visible in the status bar and help screen.

## UI States

Mergev should define clear states:

- No repository
- Repository with no conflicts
- Conflicted file list
- File merge view
- Manual edit mode
- Validation running
- Validation failed
- File saved
- File marked resolved
- All conflicts resolved
- Git flow ready to continue

## Architecture Direction

Recommended stack:

- Node.js
- TypeScript
- Ink for terminal UI
- execa or child_process for Git commands
- diff library for line and word diffs
- parser libraries for optional file validation

High-level modules:

```text
src/
  cli/
  git/
  merge/
  ui/
  validation/
  config/
  session/
```

### Git Layer

Responsibilities:

- Detect repository root
- Detect conflict state
- List unmerged files
- Read stage 1/2/3 content
- Write result file
- Run git add
- Detect rebase/cherry-pick/merge state

### Merge Model Layer

Responsibilities:

- Build conflict model from base/ours/theirs
- Track decisions
- Generate result content
- Track unresolved conflicts
- Support undo/reset

### UI Layer

Responsibilities:

- Render file list
- Render merge view
- Handle keyboard input
- Show status bar
- Show diagnostics
- Open help screen

### Validation Layer

Responsibilities:

- Detect conflict markers
- Run file-type validators
- Run custom command
- Return concise diagnostics

### Session Layer

Responsibilities:

- Persist session state
- Restore previous session
- Clear session when Git state changes

## Non-Goals

The first version should not try to:

- Replace a full text editor
- Replace WebStorm, VS Code, or Vim
- Automatically resolve every conflict
- Provide AI merging by default
- Handle every binary or generated file
- Reformat entire files unless configured
- Publish or sync any code externally

## MVP Success Criteria

The MVP is successful if a developer can:

1. Run `mergev` in a conflicted Git repository
2. See a list of conflicted files
3. Open a file in a three-pane terminal UI
4. Move conflict by conflict
5. Accept ours, theirs, or both
6. Manually edit when needed
7. Preview the final result
8. Save the file
9. Validate that conflict markers are gone
10. Mark the file as resolved with Git
11. Understand the next Git command to run

## Roadmap

### Milestone 0: Project Setup

- Package metadata
- TypeScript setup
- CLI entry placeholder
- Testing setup
- Basic repository structure

### Milestone 1: Git Conflict Detection

- Detect repository
- List unmerged files
- Read stage 1/2/3 content
- Detect current Git operation state

### Milestone 2: Merge Model

- Parse conflict data
- Build conflict blocks
- Track decisions
- Generate result content
- Unit tests for conflict decisions

### Milestone 3: Terminal UI MVP

- File list
- Three-pane file view
- Conflict navigation
- Accept ours/theirs/both
- Result preview
- Help/status bar

### Milestone 4: Save and Validate

- Write result file
- Detect remaining conflict markers
- Run basic validators
- Run git add
- Show next Git command

### Milestone 5: Editing and Workflow Polish

- External editor support
- Undo/reset
- Session recovery
- Custom check command
- Better narrow-terminal layout

### Milestone 6: Smart Conflict Handling

- File-type-aware validation
- JSON path display
- JS/TS import deduplication suggestions
- Lockfile strategy prompts

### Milestone 7: Optional AI Assistance

- Explain conflict
- Suggest result
- Highlight semantic risks
- Require explicit user confirmation

## Open Questions

- Should `mergev` run `git add` by default after successful save?
- Should `mergev continue` execute Git continuation commands or only suggest them?
- Should manual editing happen inside Ink first, or should MVP rely on `$EDITOR`?
- How much non-conflicting context should be shown by default?
- Should lockfiles be treated as special files in MVP?
- Should config live in `.mergev.json` or `package.json` first?
- Should session state be stored under `.git/mergev/` or project root?

