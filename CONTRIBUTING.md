# Contributing to Local Cocoa

First off, thanks for taking the time to contribute! ❤️

All types of contributions are encouraged and valued. See the [Table of Contents](#table-of-contents) for different ways to help and details about how this project handles them.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [I Have a Question](#i-have-a-question)
- [I Want To Contribute](#i-want-to-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Enhancements](#suggesting-enhancements)
  - [Your First Code Contribution](#your-first-code-contribution)
  - [Pull Requests](#pull-requests)
- [Styleguides](#styleguides)

## Code of Conduct

This project and everyone participating in it is governed by the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you are expected to uphold this code.

## I Have a Question

> If you want to ask a question, we assume that you have read the available [Documentation](README.md).

Before you ask a question, it is best to search for existing [Issues](https://github.com/synvo-ai/local-cocoa/issues) that might help you. In case you have found a suitable issue and still need clarification, you can write your question in this issue. It is also creating a new issue pursuant to the "I Have a Question" template.

## I Want To Contribute

### Reporting Bugs

**If you find a security vulnerability, please do NOT open an issue. Email security@synvo.ai instead.**

Before submitting bug reports, check that your issue has not already been reported.

#### How to submit a (good) bug report?

Bugs are tracked as [GitHub issues](https://github.com/synvo-ai/local-cocoa/issues). Create an issue on that repository and provide the following information by covering as much as possible:

- **Use a clear and descriptive title** for the issue to identify the problem.
- **Describe the steps to reproduce the problem** in as much detail as possible.
- **Provide specific examples** to demonstrate the steps.
- **Describe the behavior you observed** after following the steps and explain the problem with that behavior.
- **Explain which behavior you expected to see** instead and why.
- **Include screenshots and key logs** which show you following the described steps and demonstrate the problem.
- **Environment details**:
  - OS version (macOS, Windows, Linux)
  - Local Cocoa version
  - Node.js & Python versions

### Suggesting Enhancements

This section guides you through submitting an enhancement suggestion for Local Cocoa, **including completely new features and minor improvements to existing functionality**.

- **Use a clear and descriptive title** for the issue to identify the suggestion.
- **Provide a step-by-step description of the suggested enhancement** in as much detail as possible.
- **Explain why this enhancement would be useful** to most Local Cocoa users.

### Pull Requests

The process described here has several goals:

- Maintain Local Cocoa's quality
- Fix problems that are important to users
- Engage the community in working toward the best possible Local Cocoa

Please follow these steps to have your contribution considered by the maintainers:

1.  **Fork the repository** and create your branch from `main`.
2.  If you've added code that should be tested, add tests.
3.  If you've changed APIs, update the documentation.
4.  Ensure the test suite passes.
5.  Make sure your code lints.
6.  Issue that pull request!

## Code Quality

### Pre-commit Hooks

This project uses **husky** and **lint-staged** to automatically check code quality before each commit. When you run `npm install`, the pre-commit hooks are automatically set up.

**What happens on commit:**
1. Only staged `.ts` and `.tsx` files are checked
2. ESLint runs with `--fix` to auto-fix simple issues
3. ESLint runs again to catch remaining errors
4. If errors exist, the commit is **blocked** until you fix them

**Common issues that will block commits:**
- ❌ Unused imports
- ❌ Unused variables (prefix with `_` to ignore, e.g., `_unusedVar`)
- ❌ React hooks violations
- ❌ TypeScript errors

**Bypassing hooks (emergency only):**
```bash
git commit --no-verify -m "your message"
```
> ⚠️ Use sparingly! This should only be used in emergencies.

### Running Lint Manually

```bash
# Check for errors
npm run lint

# Check and auto-fix
npm run lint:fix

# Type checking only
npm run typecheck
```

### ESLint Rules

Key rules enforced (see `.eslintrc.cjs`):

| Rule | Level | Description |
|------|-------|-------------|
| `@typescript-eslint/no-unused-vars` | error | No unused variables/imports (use `_` prefix to ignore) |
| `react-hooks/rules-of-hooks` | error | Correct use of React hooks |
| `react-hooks/exhaustive-deps` | warn | Correct dependency arrays |

## Styleguides

### Git Commit Messages

- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters or less
- Reference issues and pull requests liberally after the first line
- When possible, follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat:`, `fix:`, `docs:`, `style:`, `refactor:`)
