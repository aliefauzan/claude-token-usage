# token-usage

A Claude Code mod: a pane beside the chat with your daily and monthly token usage, counted the way `/stats` counts it.

- **Overview**: today and this month (tokens, estimated cost, pace), range stats like `/stats`, and a GitHub-style heatmap.
- **Models**: estimated cost and share per model.
- **Analytics**: top projects (click one to see its chats), usage history by feature / model / project / surface, cost history, tool activity, and replies by model.

Everything is read from your own `~/.claude` folder on your machine. Nothing is sent anywhere. Costs are estimates at Anthropic API list prices.

## Install

In a Claude Code terminal session, type:

```
/plugin install token-usage --marketplace aliefauzan/claude-token-usage
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

Or from a shell:

```bash
claude plugin install token-usage --marketplace aliefauzan/claude-token-usage
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `aliefauzan/claude-token-usage`, then **Add plugin**.

Or paste this to Claude Code:

> Install the token-usage mod for me: run `claude plugin install token-usage --marketplace aliefauzan/claude-token-usage`, then tell me to start a new session.

## Use

The pane opens when a session starts. Type `/token-usage` to reopen it.

The first scan reads all your transcripts and can take a minute. After that it is cached and refreshes in about a second.

Needs `python3` (preinstalled on macOS with the Xcode command line tools).
