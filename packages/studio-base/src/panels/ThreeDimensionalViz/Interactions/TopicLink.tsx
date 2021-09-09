// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { usePanelContext } from "@foxglove/studio-base/components/PanelContext";
import Tooltip from "@foxglove/studio-base/components/Tooltip";
import { PanelConfig } from "@foxglove/studio-base/types/panels";
import { colors } from "@foxglove/studio-base/util/sharedStyleConstants";

type Props = {
  topic: string;
  variant?: "topic" | "caption";
};

export default function TopicLink({ topic, variant = "topic" }: Props): JSX.Element {
  const { openSiblingPanel } = usePanelContext();
  const openRawMessages = React.useCallback(() => {
    openSiblingPanel("RawMessages", (config: PanelConfig) => ({
      ...config,
      topicPath: topic,
    }));
  }, [openSiblingPanel, topic]);

  const color = variant === "topic" ? colors.HIGHLIGHT : colors.HIGHLIGHT_MUTED;

  return (
    <Tooltip placement="top" contents={`View ${topic} in Raw Messages panel`}>
      {/* extra span to work around tooltip NaN positioning bug */}
      <span style={{ cursor: "pointer", color }} onClick={openRawMessages}>
        {topic}
      </span>
    </Tooltip>
  );
}
