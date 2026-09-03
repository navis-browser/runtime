/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/desktop/DesktopHistory.h"

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Services.h"
#include "mozilla/dom/BrowserChild.h"
#include "mozilla/dom/ContentChild.h"
#include "nsComponentManagerUtils.h"
#include "nsIObserverService.h"
#include "nsIWidget.h"
#include "nsIWritablePropertyBag2.h"
#include "nsNetUtil.h"
#include "nsPrintfCString.h"
#include "nsXPCOMCIDInternal.h"
#include "nsXULAppAPI.h"

namespace mozilla::desktop {

using dom::BrowserChild;
using dom::ContentChild;

static constexpr auto kHistoryVisitTopic = "desktop-embedder-history-visit";
static constexpr auto kHistoryQueryTopic = "desktop-embedder-history-query";
static constexpr auto kHistoryTitleTopic = "desktop-embedder-history-title";
static constexpr auto kHistoryStatusTopic = "desktop-embedder-history-status";

StaticRefPtr<DesktopHistory> DesktopHistory::sHistory;

NS_IMPL_ISUPPORTS(DesktopHistory, IHistory, nsIObserver)

DesktopHistory::DesktopHistory() : mVisitedURIs(kTrackedUrisInitialSize) {
  if (XRE_IsParentProcess()) {
    if (nsCOMPtr<nsIObserverService> observers =
            services::GetObserverService()) {
      observers->AddObserver(this, kHistoryStatusTopic, false);
    }
  }
}

DesktopHistory::~DesktopHistory() {
  if (XRE_IsParentProcess()) {
    if (nsCOMPtr<nsIObserverService> observers =
            services::GetObserverService()) {
      observers->RemoveObserver(this, kHistoryStatusTopic);
    }
  }
}

already_AddRefed<DesktopHistory> DesktopHistory::GetSingleton() {
  if (!sHistory) {
    sHistory = new DesktopHistory();
    ClearOnShutdown(&sHistory);
  }
  RefPtr<DesktopHistory> history = sHistory;
  return history.forget();
}

bool DesktopHistory::QueryEmbedder(nsIURI* aURI, bool aDefaultVisited) {
  nsAutoCString spec;
  if (NS_FAILED(aURI->GetSpec(spec))) {
    return false;
  }

  nsCOMPtr<nsIWritablePropertyBag2> details =
      do_CreateInstance(NS_HASH_PROPERTY_BAG_CONTRACTID);
  if (!details) {
    return aDefaultVisited;
  }
  details->SetPropertyAsACString(u"url"_ns, spec);
  details->SetPropertyAsBool(u"visited"_ns, aDefaultVisited);

  if (nsCOMPtr<nsIObserverService> observers = services::GetObserverService()) {
    observers->NotifyObservers(details, kHistoryQueryTopic, nullptr);
  }

  bool visited = aDefaultVisited;
  (void)details->GetPropertyAsBool(u"visited"_ns, &visited);
  return visited;
}

void DesktopHistory::StartPendingVisitedQueries(
    PendingVisitedQueries&& aQueries) {
  if (XRE_IsContentProcess()) {
    ContentChild* content = ContentChild::GetSingleton();
    MOZ_ASSERT(content, "Content protocol is unavailable");

    constexpr size_t kBatchLimit = 4000;
    nsTArray<RefPtr<nsIURI>> uris(aQueries.Count());
    for (const auto& query : aQueries) {
      uris.AppendElement(query.GetKey());
      MOZ_ASSERT(query.GetData().IsEmpty());
      if (uris.Length() == kBatchLimit) {
        (void)content->SendStartVisitedQueries(uris);
        uris.ClearAndRetainStorage();
      }
    }
    if (!uris.IsEmpty()) {
      (void)content->SendStartVisitedQueries(uris);
    }
    return;
  }

  for (const auto& query : aQueries) {
    nsIURI* uri = query.GetKey();
    nsAutoCString spec;
    bool visited = false;
    if (NS_SUCCEEDED(uri->GetSpec(spec))) {
      visited = QueryEmbedder(uri, mVisitedURIs.Contains(spec));
      if (visited) {
        mVisitedURIs.Insert(spec);
      } else {
        mVisitedURIs.Remove(spec);
      }
    }
    NotifyVisited(uri,
                  visited ? VisitedStatus::Visited : VisitedStatus::Unvisited,
                  &query.GetData());
  }
}

NS_IMETHODIMP DesktopHistory::VisitURI(nsIWidget* aWidget, nsIURI* aURI,
                                       nsIURI* aLastVisitedURI, uint32_t aFlags,
                                       uint64_t aBrowserId) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG(aURI);

  if (!BaseHistory::CanStore(aURI)) {
    return NS_OK;
  }

  if (XRE_IsContentProcess()) {
    NS_ENSURE_ARG(aWidget);
    BrowserChild* browser = aWidget->GetOwningBrowserChild();
    NS_ENSURE_TRUE(browser, NS_ERROR_FAILURE);
    (void)browser->SendVisitURI(aURI, aLastVisitedURI, aFlags, aBrowserId);
    return NS_OK;
  }

  nsAutoCString spec;
  NS_ENSURE_SUCCESS(aURI->GetSpec(spec), NS_OK);

  nsCOMPtr<nsIWritablePropertyBag2> details =
      do_CreateInstance(NS_HASH_PROPERTY_BAG_CONTRACTID);
  bool visited = true;
  if (details) {
    details->SetPropertyAsACString(u"url"_ns, spec);
    details->SetPropertyAsBool(u"visited"_ns, visited);
    details->SetPropertyAsUint32(u"flags"_ns, aFlags);
    details->SetPropertyAsACString(
        u"browserId"_ns,
        nsPrintfCString("%llu", static_cast<unsigned long long>(aBrowserId)));
    if (aLastVisitedURI) {
      nsAutoCString lastVisitedSpec;
      if (NS_SUCCEEDED(aLastVisitedURI->GetSpec(lastVisitedSpec))) {
        details->SetPropertyAsACString(u"lastVisitedUrl"_ns, lastVisitedSpec);
      }
    }
    if (nsCOMPtr<nsIObserverService> observers =
            services::GetObserverService()) {
      observers->NotifyObservers(details, kHistoryVisitTopic, nullptr);
    }
    (void)details->GetPropertyAsBool(u"visited"_ns, &visited);
  }

  SetVisited(aURI, visited);
  return NS_OK;
}

NS_IMETHODIMP DesktopHistory::SetURITitle(nsIURI* aURI,
                                          const nsAString& aTitle) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG(aURI);

  if (XRE_IsContentProcess()) {
    ContentChild* content = ContentChild::GetSingleton();
    MOZ_ASSERT(content, "Content protocol is unavailable");
    (void)content->SendSetURITitle(aURI, PromiseFlatString(aTitle));
    return NS_OK;
  }

  nsAutoCString spec;
  if (NS_FAILED(aURI->GetSpec(spec))) {
    return NS_OK;
  }
  nsCOMPtr<nsIWritablePropertyBag2> details =
      do_CreateInstance(NS_HASH_PROPERTY_BAG_CONTRACTID);
  if (details) {
    details->SetPropertyAsACString(u"url"_ns, spec);
    details->SetPropertyAsAString(u"title"_ns, aTitle);
    if (nsCOMPtr<nsIObserverService> observers =
            services::GetObserverService()) {
      observers->NotifyObservers(details, kHistoryTitleTopic, nullptr);
    }
  }
  return NS_OK;
}

void DesktopHistory::SetVisited(nsIURI* aURI, bool aVisited) {
  nsAutoCString spec;
  if (NS_FAILED(aURI->GetSpec(spec))) {
    return;
  }
  if (aVisited) {
    mVisitedURIs.Insert(spec);
  } else {
    mVisitedURIs.Remove(spec);
  }
  NotifyVisited(aURI,
                aVisited ? VisitedStatus::Visited : VisitedStatus::Unvisited);
}

void DesktopHistory::ClearVisited() {
  nsTArray<nsCString> specs(mVisitedURIs.Count());
  for (const auto& spec : mVisitedURIs) {
    specs.AppendElement(spec);
  }
  mVisitedURIs.Clear();
  for (const auto& spec : specs) {
    nsCOMPtr<nsIURI> uri;
    if (NS_SUCCEEDED(NS_NewURI(getter_AddRefs(uri), spec))) {
      NotifyVisited(uri, VisitedStatus::Unvisited);
    }
  }
}

NS_IMETHODIMP DesktopHistory::Observe(nsISupports* aSubject, const char* aTopic,
                                      const char16_t* aData) {
  MOZ_ASSERT(NS_IsMainThread());
  if (strcmp(aTopic, kHistoryStatusTopic) != 0 || !aData) {
    return NS_OK;
  }
  if (nsDependentString(aData).EqualsLiteral("clear")) {
    ClearVisited();
    return NS_OK;
  }

  nsCOMPtr<nsIURI> uri = do_QueryInterface(aSubject);
  if (!uri || !BaseHistory::CanStore(uri)) {
    return NS_OK;
  }
  if (nsDependentString(aData).EqualsLiteral("visited")) {
    SetVisited(uri, true);
  } else if (nsDependentString(aData).EqualsLiteral("unvisited")) {
    SetVisited(uri, false);
  }
  return NS_OK;
}

}  // namespace mozilla::desktop
