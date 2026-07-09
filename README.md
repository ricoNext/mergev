# mergev

Mergev 是一个在命令行里提供三栏可视化流程的 Git 冲突解决工具，让开发者像在 WebStorm 里一样逐块选择、编辑并校验最终合并结果。

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
node dist/cli.js --help
```

## Usage

```bash
mergev
mergev path/to/conflicted-file.ts
mergev --list
mergev --list --porcelain
mergev --check "bun test"
mergev --no-add
mergev --all
mergev --mode three-pane
```

`mergev --list` and `mergev --porcelain` work in non-interactive contexts. Starting the TUI requires a TTY.

## Keys

- `j` / `k` or arrow keys: move in the file list
- `Enter`: open the selected file
- `n` / `p`: next / previous conflict
- `g`: first unresolved conflict
- `h` / `l` / `b`: choose ours / theirs / both
- `e`: edit the current conflict block with `$VISUAL`, `$EDITOR`, or `vi`
- `u` / `r`: undo / reset current conflict
- `s`: save, validate, and stage unless `--no-add` is set
- `a`: save, validate, and force `git add`
- `c`: run built-in validation
- `f`: return to the file list
- `?`: help
- `q`: leave the merge view; confirms when decisions are unsaved

## MVP Limits

- Supports UTF-8 text modify/modify conflicts with stages 1, 2, and 3.
- Binary files, invalid UTF-8, and non modify/modify conflict shapes are listed but not opened.
- Lockfiles are warned about but still resolved block by block.
- `git merge --continue`, `git rebase --continue`, and related commands are suggested, not run automatically.
- Session restore, configuration files, line/word diff, AI suggestions, and lockfile regeneration are intentionally out of scope for the MVP.
