/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.navis;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.view.KeyEvent;
import org.junit.Test;

public class NavisAndroidTextInputTest {
  @Test
  public void systemBackReachesTheActivityInsteadOfThePage() {
    assertFalse(NavisAndroidTextInput.shouldProcessKey(KeyEvent.KEYCODE_BACK));
  }

  @Test
  public void otherSystemKeysKeepTheirAndroidOwners() {
    for (final int key : new int[] {
        KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_FORWARD,
        KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN,
        KeyEvent.KEYCODE_VOLUME_MUTE, KeyEvent.KEYCODE_SEARCH,
        KeyEvent.KEYCODE_HEADSETHOOK}) {
      assertFalse("System key " + key, NavisAndroidTextInput.shouldProcessKey(key));
    }
  }

  @Test
  public void typingEditingAndGamepadInputStillReachTheEngine() {
    for (final int key : new int[] {
        KeyEvent.KEYCODE_A, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DEL,
        KeyEvent.KEYCODE_TAB, KeyEvent.KEYCODE_DPAD_LEFT,
        KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_UNKNOWN}) {
      assertTrue("Content key " + key, NavisAndroidTextInput.shouldProcessKey(key));
    }
  }
}
