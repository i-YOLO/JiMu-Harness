# Synchronizing DeepSeek Harness upstream

The repository keeps two remotes:

```text
origin    https://github.com/i-YOLO/JiMu-Harness.git
upstream  https://github.com/deepseek-ai/deepseek-harness.git
```

The upstream remote has a disabled push URL. Fetch and integrate upstream on a
review branch, then review the complete upstream-to-JiMu diff before merging:

```sh
git fetch upstream --tags
git switch -c sync/upstream-YYYYMMDD main
git merge --no-ff upstream/master
```

After resolving conflicts, rebuild the upstream libraries, JiMu apps, anonymous
tests, security scans, and release audits. New upstream plugins remain locked
until their Loader entry IDs are explicitly added to JiMu policy. Never copy a
working tree or `.git` directory from a private development checkout.
