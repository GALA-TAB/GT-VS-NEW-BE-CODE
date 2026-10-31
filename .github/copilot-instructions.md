# Working agreement: Gala Tab Backend (GT-VS-NEW-BE-CODE)

These instructions apply to everyone working in this repo, and to any AI assistant
helping them. Everyone has the same rights here, including pushing to `main`. These
are shared habits that keep our work from going missing, not permission limits.

## How deployment works (read this first)

- Backend repo: `GALA-TAB/GT-VS-NEW-BE-CODE`, deployed on Render **automatically from `main`**
  (live API: `https://gt-vs-new-be-code.onrender.com/api`). Every push to `main` is a production deploy.
- Frontend repo: `GALA-TAB/GT-VS-NEW-FE-CODE`, deployed on Vercel. Only its `main` branch goes to Production.
- Work that is not on `main` is not live, and teammates who pull `main` will never see it.
- More than one person pushes to `main`. Never assume your branch is the only source of truth.

## Rules for every change

1. **Start current.** Run `git fetch origin` and make sure you are up to date with `origin/main`.
   If you are on a feature branch, `git rebase origin/main` so it does not drift.
2. **Keep branches short-lived.** When work is finished and tested, merge it into `main` (push to
   main or open a pull request). Do not leave finished work sitting on a feature branch.
3. **Before every push:** `git fetch origin`, then `git rebase origin/main`. If there are
   conflicts, stop and look at them. Never force push (`--force`) to `main`, and never resolve a
   conflict by discarding someone else's changes.
4. **Backend first.** The backend must be merged and deployed before any frontend change that
   depends on it. Keep changes backward compatible where older clients (for example the mobile
   app) still call the API: add optional fields rather than making new ones mandatory.
5. **Check the code before a push goes live.** Run `node -c` on files you changed and make sure the
   server still starts, because a broken `main` takes the live API down.
6. **Verify after pushing.** Confirm `git log origin/main -3` shows your commit, then check the
   Render deploy finished and `https://gt-vs-new-be-code.onrender.com/` responds.
7. **No secrets.** Never commit tokens, passwords, API keys, or `.env` files.
8. **Finish clean.** At the end of a task, run `git status -sb` and make sure nothing is left
   unpushed or unmerged.

## At the start of a session

Check for commits on remote branches that are not on `main`:

```
git fetch origin
git log origin/main..origin/<branch> --format='%h %an %ad %s' --date=short
```

If there are any, tell the user and ask whether to merge them. Do not merge someone else's
branch without asking first.

## Privacy and security

- Government ID images are sensitive. Only admins and the customer who uploaded them may see
  them, and admin views are audit-logged. Never return ID images to vendors.
- Access to a booking agreement must be limited to that booking's customer, that booking's
  vendor (and their staff), and admins.
