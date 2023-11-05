import type {
  DurableObjectNamespace,
  DurableObjectState,
  KVNamespace,
} from "https://deno.land/x/denoflare@v0.5.2/common/cloudflare_workers_types.d.ts";
import { Hono } from "https://deno.land/x/hono@v3.9.2/mod.ts";
import type {
  contacts,
  updates,
} from "https://deno.land/x/mtproto@v0.4.4/gen/api.d.ts";
import global from "https://deno.land/x/mtproto@v0.4.4/gen/api.d.ts";
import MTProto from "https://deno.land/x/mtproto@v0.4.4/mod.ts";
import Abridged from "https://deno.land/x/mtproto@v0.4.4/transport/codec/abridged.ts";
import Obfuscated from "https://deno.land/x/mtproto@v0.4.4/transport/codec/obfuscated.ts";
import factory from "https://deno.land/x/mtproto@v0.4.4/transport/connection/websocket.ts";
import { stringify } from "https://esm.sh/safe-stable-stringify@2.4.3";
import { DurableObjectStorageAdapter } from "./utils/DurableObjectStorageAdapter.ts";
import { assertIntRange, requireBigInt, requireInt } from "./utils/Number.ts";
import { joinParts } from "./utils/Keys.ts";

export interface Env {
  MTProtoService: DurableObjectNamespace;
  KV: KVNamespace;
  TgApiToken: string;
  TgInitDC: string;
  TgBotToken: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cache = await caches.open("denoflare");
    let response = await cache.match(request);
    if (response) {
      return response;
    }
    const id = env.MTProtoService.idFromName("default");
    const obj = env.MTProtoService.get(id);
    response = await obj.fetch(request);
    if (response.status === 200) cache.put(request, response.clone());
    return response;
  },
};

export class MTProtoService {
  mtproto: MTProto;
  #inited?: Promise<void>;
  #resolve_cache = new Map<string, contacts.ResolvedPeer>();
  #channel_cache = new Map<string, global.Chat<"channel">>();
  #storage: DurableObjectStorageAdapter;

  constructor(private state: DurableObjectState, private env: Env) {
    this.#storage = new DurableObjectStorageAdapter(state.storage);
    const [id, hash] = env.TgApiToken.split(":");
    this.mtproto = new MTProto({
      api_id: +id,
      api_hash: hash,
      environment: {
        app_version: "1.0.0",
        device_model: "Unknown",
        system_version: "0.0.0",
      },
      transport_factory: factory(() => new Obfuscated(new Abridged())),
      initdc: {
        id: +env.TgInitDC,
        test: false,
        ip: "unused",
        port: 443,
      },
    });
  }

  private init() {
    return (this.#inited ??= (async () => {
      try {
        await this.#storage.populate();
        await this.mtproto.init();
        const rpc = await this.mtproto.rpc();
        try {
          await rpc.api.bots.getBotInfo({
            lang_code: "en",
          });
        } catch {
          await rpc.api.auth.importBotAuthorization({
            flags: 0,
            bot_auth_token: this.env.TgBotToken,
          });
        }
        // rpc.on("updateNewChannelMessage", (msg) => {

        // })
      } catch (e) {
        console.error(e);
        this.#inited = undefined;
        throw e;
      }
    })());
  }

  private async resolveUsername(channel: string) {
    return (
      this.#resolve_cache.get(channel) ??
      (await (async () => {
        const rpc = await this.mtproto.rpc();
        const result: contacts.ResolvedPeer =
          await rpc.api.contacts.resolveUsername({
            username: channel,
          });
        this.#resolve_cache.set(channel, result);
        const chat = result.chats[0];
        if (chat?._ === "channel") this.#channel_cache.set(channel, chat);
        return result;
      })())
    );
  }

  private async getChat(username_or_id: string) {
    const parsed = requireBigInt(username_or_id);
    if (parsed) {
      const id = BigInt(username_or_id);
      return (
        this.#channel_cache.get(id.toString()) ??
        (await (async () => {
          const rpc = await this.mtproto.rpc();
          const result = await rpc.api.messages.getChats({
            id: [id],
          });
          const chat = result.chats[0];
          if (!chat || chat._ !== "channel")
            throw new Error("Chat not found or not joined");
          this.#channel_cache.set(id.toString(), chat);
          return chat;
        })())
      );
    } else {
      const peer = await this.resolveUsername(username_or_id);
      const chat = peer.chats[0];
      if (chat?._ === "channel") return chat;
      throw new Error("Chat not found or not joined");
    }
  }

  private async getChannelDifference(
    channel: global.Chat<"channel">,
    pts: number
  ) {
    const rpc = await this.mtproto.rpc();
    return await rpc.api.updates.getChannelDifference({
      pts,
      filter: {
        _: "channelMessagesFilterEmpty",
      },
      channel: {
        _: "inputChannel",
        channel_id: channel.id,
        access_hash: channel.access_hash!,
      },
      limit: 100_000,
      force: true,
    });
  }

  private async applyChannelDifference(
    channel: global.Chat<"channel">,
    updates: updates.ChannelDifference<"updates.channelDifference">
  ) {
    let max_id: number | undefined;
    for (const new_message of updates.new_messages) {
      if (new_message._ === "messageEmpty") continue;
      await this.state.storage.put(
        joinParts("channel", channel.id, "message", new_message.id),
        new_message
      );
      max_id = Math.max(max_id ?? 0, new_message.id);
    }

    for (const chat of updates.chats) {
      if (chat._ === "channel") {
        await this.state.storage.put(joinParts("channel", channel.id), chat);
      } else if (chat._ === "chat") {
        await this.state.storage.put(joinParts("chat", chat.id), chat);
      }
    }

    for (const user of updates.users) {
      if (user._ === "user") {
        await this.state.storage.put(joinParts("user", user.id), user);
      }
    }

    for (const update of updates.other_updates) {
      switch (update._) {
        case "updateEditChannelMessage":
          await this.state.storage.put(
            joinParts("channel", channel.id, "message", update.message.id),
            update.message
          );
          break;
        case "updateDeleteChannelMessages": {
          const pinned =
            ((await this.state.storage.get(
              joinParts("channel", channel.id, "pinned")
            )) as number[]) ?? [];
          let modified = false;
          for (const id of update.messages) {
            await this.state.storage.delete(
              joinParts("channel", channel.id, "message", id)
            );
            if (pinned.includes(id)) {
              pinned.splice(pinned.indexOf(id), 1);
              modified = true;
            }
          }
          if (modified) {
            await this.state.storage.put(
              joinParts("channel", channel.id, "pinned"),
              pinned
            );
          }
          break;
        }
        case "updatePinnedChannelMessages": {
          const pinned =
            ((await this.state.storage.get(
              joinParts("channel", channel.id, "pinned")
            )) as number[]) ?? [];
          for (const id of update.messages) {
            const message = (await this.state.storage.get(
              joinParts("channel", channel.id, "message", id)
            )) as global.Message<"message">;
            if (update.pinned) {
              message.pinned = true;
              if (!pinned.includes(id)) pinned.push(id);
            } else {
              delete message.pinned;
              if (pinned.includes(id)) pinned.splice(pinned.indexOf(id), 1);
            }
            await this.state.storage.put(
              joinParts("channel", channel.id, "message", id),
              message
            );
          }
          pinned.sort((a, b) => a - b);
          await this.state.storage.put(
            joinParts("channel", channel.id, "pinned"),
            pinned
          );
          break;
        }
      }
    }

    await this.state.storage.put(
      joinParts("channel", channel.id, "pts"),
      updates.pts
    );
  }

  private async handleChannelDifferenceTooLong(
    channel: global.Chat<"channel">,
    updates: updates.ChannelDifference<"updates.channelDifferenceTooLong">
  ) {
    throw new Error("TODO");
  }

  private async getChannelMessages(
    channel: global.Chat<"channel">,
    { cursor, limit }: { cursor: number; limit: number }
  ) {
    const pts = (await this.state.storage.get(
      joinParts("channel", channel.id, "pts")
    )) as number | undefined;
    if (cursor === 0) cursor = Number.MAX_SAFE_INTEGER;
    const diff = await this.getChannelDifference(channel, pts ?? 1);
    if (diff._ === "updates.channelDifference") {
      await this.applyChannelDifference(channel, diff);
    } else if (diff._ === "updates.channelDifferenceTooLong") {
      await this.handleChannelDifferenceTooLong(channel, diff);
    }

    const messages = (await this.state.storage.list({
      allowConcurrency: true,
      prefix: joinParts("channel", channel.id, "message"),
      reverse: true,
      end: joinParts("channel", channel.id, "message", cursor),
      limit,
    })) as Map<string, global.Message>;

    return [...messages.values()];
  }

  async fetch(request: Request) {
    return await this.hono.fetch(request, this.env);
  }

  hono = new Hono()
    .use("*", async (_, next) => {
      await this.init();
      await next();
    })
    .onError((err) => {
      console.error(err);
      return new Response(err.message, { status: 500 });
    })
    .post("/reset", async () => {
      await this.state.storage.deleteAll();
      return new Response();
    })
    .get("/", async () => {
      const rpc = await this.mtproto.rpc();
      const config = rpc.api.help.getConfig();
      return new Response(stringify(config));
    })
    .get("/resolve/:username", async (ctx) => {
      const channel = await this.resolveUsername(ctx.req.param("username"));
      return new Response(stringify(channel));
    })
    .get("/channel/:channel/messages", async (ctx) => {
      const cursor = requireInt(ctx.req.query("cursor"), 0);
      assertIntRange(cursor, 0, Number.MAX_SAFE_INTEGER);
      const limit = requireInt(ctx.req.query("limit"), 100);
      assertIntRange(limit, 1, 100);
      const channel = await this.getChat(ctx.req.param("channel"));
      const messages = await this.getChannelMessages(channel, {
        cursor,
        limit,
      });
      return new Response(stringify(messages));
    });
}
