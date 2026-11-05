/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko;

import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;

import org.junit.Test;

public class EventDispatcherTest {
  @Test
  public void closeBeforeNativeAttachmentDoesNotEnterJni() {
    final EventDispatcher dispatcher = EventDispatcher.byName("test-unattached");
    dispatcher.shutdown();
    dispatcher.shutdown();
    final EventDispatcher replacement = EventDispatcher.byName("test-unattached");
    assertNotSame(dispatcher, replacement);
    // Late cleanup of the old owner must not evict the new owner.
    dispatcher.shutdown();
    assertSame(replacement, EventDispatcher.byName("test-unattached"));
    replacement.shutdown();
  }

  @Test(expected = RuntimeException.class)
  public void globalDispatcherCannotBeShutDownByACaller() {
    EventDispatcher.getInstance().shutdown();
  }
}
