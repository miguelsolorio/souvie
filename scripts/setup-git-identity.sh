#!/bin/sh
# Pin this repository to the personal Gmail identity and install the guard hook.
# Run once per clone. Worktrees share the clone's config and hooks, so builders inherit it.
set -e
cd "$(git rev-parse --show-toplevel)"

git config --local user.name  "Miguel Solorio"
git config --local user.email "miguel.solorio07@gmail.com"
git config --local user.useConfigOnly true
# The global config signs with an SSH key that may be registered to a work account.
# Signing stays off here unless a personal key is configured locally.
git config --local commit.gpgsign false
git config --local tag.gpgsign false
git config --local core.hooksPath .githooks
chmod +x .githooks/*

echo "git identity for $(basename "$PWD"): $(git config user.name) <$(git config user.email)>, signing off, hooks in .githooks"
