/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.process;

import java.util.UUID;
import org.mozilla.gecko.navis.NavisAndroidNotifications;

public final class NavisChildServiceNamespace {
  public static final int PROFILE_SLOT_COUNT = 8;
  private static final String PROFILE_SERVICES =
      "org.mozilla.gecko.process.NavisProfileChildProcessServices";
  private static String sConfiguredProcess;

  private NavisChildServiceNamespace() {}

  public static synchronized void configureForProcess(final String processName) {
    if (processName.equals(sConfiguredProcess)) {
      return;
    }
    if (sConfiguredProcess != null) {
      throw new IllegalStateException("Navis process namespace cannot change");
    }
    final String prefix = serviceClassPrefix(processName, GeckoChildProcessServices.class.getName());
    ServiceUtils.setServiceClassPrefix(prefix);
    final String receiver = prefix.startsWith(PROFILE_SERVICES + "$")
        ? prefix + "$NotificationReceiver"
        : NavisAndroidNotifications.NotificationReceiver.class.getName();
    NavisAndroidNotifications.configureProcess(receiver, processName + ":" + UUID.randomUUID());
    sConfiguredProcess = processName;
  }

  static String serviceClassPrefix(final String processName, final String defaultPrefix) {
    final int separator = processName.lastIndexOf(':');
    if (separator < 0) {
      return defaultPrefix;
    }
    final String name = processName.substring(separator + 1);
    if (!name.matches("profile[0-9]+")) {
      return defaultPrefix;
    }
    final int slot = Integer.parseInt(name.substring("profile".length()));
    if (slot < 0 || slot >= PROFILE_SLOT_COUNT || !name.equals("profile" + slot)) {
      throw new IllegalStateException("Unknown Navis profile process: " + name);
    }
    return PROFILE_SERVICES + "$" + name;
  }
}
