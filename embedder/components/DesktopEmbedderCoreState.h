/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_desktop_DesktopEmbedderCoreState_h
#define mozilla_desktop_DesktopEmbedderCoreState_h

#include "nsIDesktopEmbedderCoreState.h"

struct NavisCoreRuntime;

namespace mozilla::desktop {

class DesktopEmbedderCoreState final : public nsIDesktopEmbedderCoreState {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIDESKTOPEMBEDDERCORESTATE

  DesktopEmbedderCoreState();

 private:
  ~DesktopEmbedderCoreState();

  NavisCoreRuntime* mRuntime;
};

}  // namespace mozilla::desktop

#endif  // mozilla_desktop_DesktopEmbedderCoreState_h
