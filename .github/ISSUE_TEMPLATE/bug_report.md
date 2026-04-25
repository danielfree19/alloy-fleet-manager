---
name: Bug report
about: Something is broken or behaves unexpectedly
title: ""
labels: ["bug", "needs-triage"]
assignees: []
---

<!-- Thanks for filing a bug! Please fill in as much as you can — fields
left empty just slow down triage. If this is a SECURITY report, stop
here and follow SECURITY.md instead. -->

### Summary

<!-- One line describing what's wrong. -->

### Component

- [ ] `fleet-manager` (API)
- [ ] `fleet-ui` (admin SPA)
- [ ] `fleet-agent` (legacy REST agent)
- [ ] `fleetctl` (Go CLI)
- [ ] `terraform-provider-fleet`
- [ ] `@fleet-oss/sdk`
- [ ] Catalog template (`catalog/templates.json`)
- [ ] Docs only
- [ ] Other / unsure

### Version

- Release tag or commit SHA: <!-- e.g. v0.2.1 or 4f3a1c0 -->
- Deployment shape: <!-- docker compose / k8s / dev / etc. -->

### Steps to reproduce

1.
2.
3.

### Actual behaviour

```
<!-- paste the error, truncated logs, the failing curl, etc. -->
```

### Expected behaviour

<!-- What did you think would happen? -->

### Logs / context

<details><summary>fleet-manager logs (last ~50 lines)</summary>

```
```

</details>

<details><summary>relevant config (REDACT secrets!)</summary>

```
```

</details>
