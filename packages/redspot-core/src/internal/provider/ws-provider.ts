// Copyright 2017-2020 @polkadot/rpc-provider authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable camelcase */

import { isChildClass, isNull, isUndefined } from "@polkadot/util";
import WS from "@polkadot/x-ws";
import assert from "assert";
import chalk from "chalk";
import EventEmitter from "eventemitter3";
import {
  WsProvider as IWsProvider,
  JsonRpcResponse,
  ProviderInterfaceCallback,
  ProviderInterfaceEmitCb,
  ProviderInterfaceEmitted,
} from "../../types";
import log from "../log";
import Coder from "./coder";
import { getWSErrorString } from "./errors";

interface SubscriptionHandler {
  callback: ProviderInterfaceCallback;
  type: string;
}

interface WsStateAwaiting {
  callback: ProviderInterfaceCallback;
  method: string;
  params: any[];
  subscription?: SubscriptionHandler;
}

interface WsStateSubscription extends SubscriptionHandler {
  method: string;
  params: any[];
}

const ALIASSES: { [index: string]: string } = {
  chain_finalisedHead: "chain_finalizedHead",
  chain_subscribeFinalisedHeads: "chain_subscribeFinalizedHeads",
  chain_unsubscribeFinalisedHeads: "chain_unsubscribeFinalizedHeads",
};

const RETRY_DELAY = 1000;

/**
 * @name WsProvider
 *
 * @description The WebSocket Provider allows sending requests using WebSocket to a WebSocket RPC server TCP port. Unlike the [[HttpProvider]], it does support subscriptions and allows listening to events such as new blocks or balance changes.
 *
 * @see [[HttpProvider]]
 */
export default class WsProvider implements IWsProvider {
  readonly #coder: Coder;

  readonly #endpoints: string[];

  readonly #headers: Record<string, string>;

  readonly #eventemitter: EventEmitter;

  readonly #handlers: Record<string, WsStateAwaiting> = {};

  readonly #queued: Record<string, string> = {};

  readonly #waitingForId: Record<string, JsonRpcResponse> = {};

  #autoConnectMs: number;

  #endpointIndex: number;

  #isConnected = false;

  #subscriptions: Record<string, WsStateSubscription> = {};

  #websocket: WebSocket | null;

  /**
   * @param {string | string[]}  endpoint    The endpoint url. Usually `ws://ip:9944` or `wss://ip:9944`, may provide an array of endpoint strings.
   * @param {boolean} autoConnect Whether to connect automatically or not.
   */
  constructor(
    endpoint: string | string[],
    headers: Record<string, string> = {}
  ) {
    const endpoints = Array.isArray(endpoint) ? endpoint : [endpoint];

    assert(endpoints.length !== 0, "WsProvider requires at least one Endpoint");

    endpoints.forEach((endpoint) => {
      assert(
        /^(wss|ws):\/\//.test(endpoint),
        `Endpoint should start with 'ws://', received '${endpoint}'`
      );
    });

    this.#eventemitter = new EventEmitter();
    this.#coder = new Coder();
    this.#endpointIndex = -1;
    this.#endpoints = endpoints;
    this.#headers = headers;
    this.#websocket = null;
  }

  /**
   * @summary `true` when this provider supports subscriptions
   */
  public get hasSubscriptions(): boolean {
    return true;
  }

  /**
   * @summary Whether the node is connected or not.
   * @return {boolean} true if connected
   */
  public get isConnected(): boolean {
    return this.#isConnected;
  }

  /**
   * @description Returns a clone of the object
   */
  public clone(): WsProvider {
    return new WsProvider(this.#endpoints);
  }

  /**
   * @summary Manually connect
   * @description The [[WsProvider]] connects automatically by default, however if you decided otherwise, you may
   * connect manually using this method.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  public async connect(): Promise<void> {
    try {
      this.#endpointIndex = (this.#endpointIndex + 1) % this.#endpoints.length;
      this.#websocket =
        typeof WebSocket !== "undefined" && isChildClass(WebSocket, WS)
          ? new WS(this.#endpoints[this.#endpointIndex])
          : // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // WS may be an instance of w3cwebsocket, which supports headers
            new (WS as any)(
              this.#endpoints[this.#endpointIndex],
              undefined,
              undefined,
              this.#headers
            );

      this.#websocket.onclose = this.#onSocketClose;
      this.#websocket.onerror = this.#onSocketError;
      this.#websocket.onmessage = this.#onSocketMessage;
      this.#websocket.onopen = this.#onSocketOpen;

      return new Promise((resolve, reject) => {
        let isConnected = false;
        const eventemitter = this.#eventemitter;

        function removeAll(event?) {
          eventemitter.removeListener("connected", onConnect);
          eventemitter.removeListener("disconnected", onClose);
          eventemitter.removeListener("error", onClose);
          if (isConnected) {
            resolve();
          } else {
            reject(event);
          }
        }

        function onConnect() {
          isConnected = true;
          removeAll();
        }

        function onClose(event) {
          isConnected = false;
          removeAll(event);
        }

        this.#eventemitter.once("connected", onConnect);
        this.#eventemitter.once("disconnected", onClose);
        this.#eventemitter.once("error", onClose);
      });
    } catch (error) {
      log.error(chalk.red(error));

      this.#emit("error", error);

      throw error;
    }
  }

  /**
   * @description Connect, never throwing an error, but rather forcing a retry
   */
  public async connectWithRetry(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      setTimeout((): void => {
        this.connectWithRetry().catch((): void => {
          // does not throw
        });
      }, this.#autoConnectMs || RETRY_DELAY);
    }
  }

  /**
   * @description Manually disconnect from the connection, clearing autoconnect logic
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  public async disconnect(): Promise<void> {
    try {
      assert(
        !isNull(this.#websocket),
        "Cannot disconnect on a non-connected websocket"
      );

      // switch off autoConnect, we are in manual mode now
      this.#autoConnectMs = 0;

      // 1000 - Normal closure; the connection successfully completed
      this.#websocket.close(1000);
      this.#websocket = null;
    } catch (error) {
      log.error(chalk.red(error));

      this.#emit("error", error);

      throw error;
    }
  }

  /**
   * @summary Listens on events after having subscribed using the [[subscribe]] function.
   * @param  {ProviderInterfaceEmitted} type Event
   * @param  {ProviderInterfaceEmitCb}  sub  Callback
   * @return unsubscribe function
   */
  public on(
    type: ProviderInterfaceEmitted,
    sub: ProviderInterfaceEmitCb
  ): () => void {
    this.#eventemitter.on(type, sub);

    return (): void => {
      this.#eventemitter.removeListener(type, sub);
    };
  }

  /**
   * @summary Send JSON data using WebSockets to configured HTTP Endpoint or queue.
   * @param method The RPC methods to execute
   * @param params Encoded paramaters as appliucable for the method
   * @param subscription Subscription details (internally used)
   */
  public send(
    method: string,
    params: any[],
    subscription?: SubscriptionHandler
  ): Promise<any> {
    return new Promise((resolve, reject): void => {
      try {
        const json = this.#coder.encodeJson(method, params);
        const request = JSON.stringify(json);
        const id = this.#coder.getId();

        const callback = (error?: Error | null, result?: any): void => {
          error ? reject(error) : resolve(result);
        };

        log.debug(
          `${chalk.green(`⬆`)} Id: ${chalk.bold(`%d`)}, method: ${
            json.method
          }, params: %j`,
          json.id,
          json.params
        );

        this.#handlers[id] = {
          callback,
          method,
          params,
          subscription,
        };

        if (this.isConnected && !isNull(this.#websocket)) {
          this.#websocket.send(request);
        } else {
          this.#queued[id] = request;
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * @name subscribe
   * @summary Allows subscribing to a specific event.
   * @param  {string}                     type     Subscription type
   * @param  {string}                     method   Subscription method
   * @param  {any[]}                 params   Parameters
   * @param  {ProviderInterfaceCallback} callback Callback
   * @return {Promise<number>}                     Promise resolving to the dd of the subscription you can use with [[unsubscribe]].
   */
  public async subscribe(
    type: string,
    method: string,
    params: any[],
    callback: ProviderInterfaceCallback
  ): Promise<number | string> {
    const id = (await this.send(method, params, { callback, type })) as Promise<
      number | string
    >;

    return id;
  }

  /**
   * @summary Allows unsubscribing to subscriptions made with [[subscribe]].
   */
  public async unsubscribe(
    type: string,
    method: string,
    id: number | string
  ): Promise<boolean> {
    const subscription = `${type}::${id}`;

    // FIXME This now could happen with re-subscriptions. The issue is that with a re-sub
    // the assigned id now does not match what the API user originally received. It has
    // a slight complication in solving - since we cannot rely on the send id, but rather
    // need to find the actual subscription id to map it
    if (isUndefined(this.#subscriptions[subscription])) {
      log.warn(`Unable to find active subscription=${subscription}`);

      return false;
    }

    delete this.#subscriptions[subscription];

    const result = (await this.send(method, [id])) as Promise<boolean>;

    return result;
  }

  #emit = (type: ProviderInterfaceEmitted, ...args: any[]): void => {
    this.#eventemitter.emit(type, ...args);
  };

  #onSocketClose = (event: CloseEvent): void => {
    log.error(
      chalk.red(
        `Disconnected from ${this.#endpoints[this.#endpointIndex]}: ${
          event.code
        }:: ${event.reason || getWSErrorString(event.code)}`
      )
    );

    this.#isConnected = false;
    this.#emit("disconnected");
  };

  #onSocketError = (error: Event): void => {
    log.warn(`Socket event: ${error.type}`);
    this.#emit("error", error);
  };

  #onSocketMessage = (message: MessageEvent): void => {
    const response = JSON.parse(message.data as string) as JsonRpcResponse;
    const isMsg = isUndefined(response.method);

    const subresult = (result) => {
      try {
        const str = JSON.stringify(result);
        if (str.length > 63) {
          return `${str.substr(0, 60)}...`;
        }
        return str;
      } catch {
        return "...";
      }
    };

    if (isMsg) {
      log.debug(
        `${chalk.red("⬇")} Id: ${chalk.bold(`%d`)}, result: ${subresult(
          response.result
        )}`,
        response.id
      );

      return this.#onSocketMessageResult(response);
    } else {
      log.debug(
        `${chalk.red("⬇")} SubId: ${chalk.bold(
          response.params.subscription.toString()
        )}, result: ${subresult(response.params.result)}`
      );
      this.#onSocketMessageSubscribe(response);
    }
  };

  #onSocketMessageResult = (response: JsonRpcResponse): void => {
    const handler = this.#handlers[response.id];

    if (!handler) {
      // log.warn(`Unable to find handler for id=${response.id}`);

      return;
    }

    try {
      const { method, params, subscription } = handler;
      const result = this.#coder.decodeResponse(response) as string;

      // first send the result - in case of subs, we may have an update
      // immediately if we have some queued results already
      handler.callback(null, result);

      if (subscription) {
        const subId = `${subscription.type}::${result}`;

        this.#subscriptions[subId] = {
          ...subscription,
          method,
          params,
        };

        // if we have a result waiting for this subscription already
        if (this.#waitingForId[subId]) {
          this.#onSocketMessageSubscribe(this.#waitingForId[subId]);
        }
      }
    } catch (error) {
      handler.callback(error, undefined);
    }

    delete this.#handlers[response.id];
  };

  #onSocketMessageSubscribe = (response: JsonRpcResponse): void => {
    const method =
      ALIASSES[response.method as string] || response.method || "invalid";
    const subId = `${method}::${response.params.subscription}`;
    const handler = this.#subscriptions[subId];

    if (!handler) {
      // store the JSON, we could have out-of-order subid coming in
      this.#waitingForId[subId] = response;

      // log.warn(`Unable to find handler for subscription=${subId}`);

      return;
    }

    // housekeeping
    delete this.#waitingForId[subId];

    try {
      const result = this.#coder.decodeResponse(response);

      handler.callback(null, result);
    } catch (error) {
      handler.callback(error, undefined);
    }
  };

  #onSocketOpen = (): boolean => {
    assert(!isNull(this.#websocket), "WebSocket cannot be null in onOpen");

    log.info("Connected to", this.#endpoints[this.#endpointIndex]);

    this.#isConnected = true;

    this.#emit("connected");
    this.#sendQueue();
    this.#resubscribe();

    return true;
  };

  #resubscribe = (): void => {
    const subscriptions = this.#subscriptions;

    this.#subscriptions = {};

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    Object.keys(subscriptions).forEach(
      async (id): Promise<void> => {
        const { callback, method, params, type } = subscriptions[id];

        // only re-create subscriptions which are not in author (only area where
        // transactions are created, i.e. submissions such as 'author_submitAndWatchExtrinsic'
        // are not included (and will not be re-broadcast)
        if (type.startsWith("author_")) {
          return;
        }

        try {
          await this.subscribe(type, method, params, callback);
        } catch (error) {
          log.error(chalk.red(error));
        }
      }
    );
  };

  #sendQueue = (): void => {
    Object.keys(this.#queued).forEach((id): void => {
      try {
        // we have done the websocket check in onSocketOpen, if an issue, will catch it
        (this.#websocket as WebSocket).send(this.#queued[id]);

        delete this.#queued[id];
      } catch (error) {
        log.error(chalk.red(error));
      }
    });
  };
}
