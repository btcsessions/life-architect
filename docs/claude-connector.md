# Using Life Architect from Claude on your phone

Life Architect runs a small connector on port **4601**, separate from the deck on 4600. It speaks MCP, so Claude
(and other assistants that support custom connectors) can use it from anywhere, including by voice in the phone app.

What it can do: add and change tasks, add trips and bookings, log spending, draft email replies and hand-offs, pass
instructions to Hermes, read what's next, and summarise the inbox by sender and subject.

What it can't do: read or write People, read Money, read email bodies, or send email. Drafted email waits for a tap
in the app. Every call needs the relay token from **Settings › Relay**.

## 1. Make the connector reachable over HTTPS

Claude calls connectors from Anthropic's servers, so the connector needs a public HTTPS address. Tailscale Funnel
gives one without opening a port on your router. On the Umbrel, in a terminal:

    sudo docker ps --format '{{.Names}}' | grep -i tailscale
    sudo docker exec <that name> tailscale funnel --bg 4601

The first run may print a link to approve Funnel for your tailnet; open it and allow it, then run the command again.
It then prints an address like `https://umbrel.your-tailnet.ts.net`. Only port 4601 is published. The deck, Money
and People stay on Tailscale.

To switch it off later: `sudo docker exec <that name> tailscale funnel --https=443 off`

## 2. Add it to Claude

On claude.ai (web), open Settings › Connectors › Add custom connector.

- Name: Life Architect
- URL: `https://<the address from step 1>/mcp`
- Under advanced/request headers, add `Authorization` with the value `Bearer <your relay token>`

Paste the token yourself. Once added on the web it is available in the phone app.

## 3. Use it

In a voice conversation: "Add to Life Architect: finish the outline by Thursday, important", "What's next on my
deck?", "Log 40 dollars for lunch", "What email is waiting on me?", "Reply to Dana that April works" (drafted, then
you tap Send in the app).

If the token leaks, create a new one in Settings › Relay. The old one stops working at once; update it in Claude
and in Hermes.
