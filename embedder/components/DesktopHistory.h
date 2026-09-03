/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_desktop_DesktopHistory_h
#define mozilla_desktop_DesktopHistory_h

#include "mozilla/BaseHistory.h"
#include "mozilla/StaticPtr.h"
#include "nsIObserver.h"
#include "nsTHashSet.h"

namespace mozilla::desktop {

class DesktopHistory final : public BaseHistory, public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIOBSERVER

  NS_IMETHOD VisitURI(nsIWidget*, nsIURI*, nsIURI*, uint32_t, uint64_t) final;
  NS_IMETHOD SetURITitle(nsIURI*, const nsAString&) final;

  static already_AddRefed<DesktopHistory> GetSingleton();

  void StartPendingVisitedQueries(PendingVisitedQueries&&) final;

 private:
  DesktopHistory();
  ~DesktopHistory();

  bool QueryEmbedder(nsIURI*, bool);
  void SetVisited(nsIURI*, bool);
  void ClearVisited();

  nsTHashSet<nsCStringHashKey> mVisitedURIs;
  static StaticRefPtr<DesktopHistory> sHistory;
};

}  // namespace mozilla::desktop

#endif  // mozilla_desktop_DesktopHistory_h
