// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PropsWithChildren, useCallback, useMemo } from "react";
import { useAsync, useLocalStorage } from "react-use";

import { useShallowMemo } from "@foxglove/hooks";
import Logger from "@foxglove/log";
import { useConsoleApi } from "@foxglove/studio-base/context/ConsoleApiContext";
import CurrentUserContext, { User } from "@foxglove/studio-base/context/CurrentUserContext";

const log = Logger.getLogger(__filename);

/**
 * CurrentUserProvider attempts to load the current user's profile if there is an authenticated
 * session
 */
export default function ConsoleApiCurrentUserProvider(
  props: PropsWithChildren<unknown>,
): JSX.Element {
  const api = useConsoleApi();
  const [bearerToken, setBearerToken, removeBearerToken] =
    useLocalStorage<string>("fox.bearer-token");

  // We want to support starting the app while offline. Various children components of the provider
  // use the presence of the user as an indicator of sign-in state. We cache the user to provide a
  // stale-while-loading value so the app can open with no connection and update the cached record
  // once online.
  const [cachedCurrentUser, setCachedCurrentUser, removeCachedCurrentUser] = useLocalStorage<User>(
    "fox.current-user",
    undefined,
    {
      raw: false,
      serializer: (value: User) => JSON.stringify(value),
      deserializer: (value: string) => JSON.parse(value) as User,
    },
  );

  // We need to set the api auth header info before any other parts of the app can use the api
  useMemo(() => {
    if (!bearerToken) {
      return;
    }
    api.setAuthHeader(`Bearer ${bearerToken}`);
  }, [api, bearerToken]);

  const { loading } = useAsync(async () => {
    try {
      if (!bearerToken) {
        return undefined;
      }
      const me = await api.me();
      setCachedCurrentUser(me);
      return me;
    } catch (error) {
      log.error(error);
      return undefined;
    }
  }, [api, bearerToken, setCachedCurrentUser]);

  const signOut = useCallback(async () => {
    removeBearerToken();
    removeCachedCurrentUser();
    await api.signout();
  }, [api, removeBearerToken, removeCachedCurrentUser]);

  const currentUser = useMemo<User | undefined>(() => {
    return cachedCurrentUser;
  }, [cachedCurrentUser]);

  const value = useShallowMemo({ currentUser, setBearerToken, signOut });

  // Wait for first time loading to complete
  if (!currentUser && loading) {
    return <></>;
  }

  return <CurrentUserContext.Provider value={value}>{props.children}</CurrentUserContext.Provider>;
}
