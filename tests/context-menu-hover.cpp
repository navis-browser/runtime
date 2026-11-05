// SPDX-License-Identifier: MPL-2.0
// Native methods are inserted from the prepared Gecko source by the runner.
// These peers model popup ownership and IPC delivery, not native GUI execution.
#include <cassert>
#include <cstdint>
#include <memory>
#include <utility>
#include <vector>

template <typename T> using RefPtr = std::shared_ptr<T>;
template <typename T> using UniquePtr = std::unique_ptr<T>;
template <typename T, typename... A> auto MakeUnique(A&&... args) {
  return std::make_unique<T>(std::forward<A>(args)...);
}
template <typename T, size_t N> struct AutoTArray : std::vector<T> {
  void AppendElement(T item) { this->push_back(std::move(item)); }
};

struct Document {};
struct Element {
  Document* document;
  Document* OwnerDoc() { return document; }
};
struct BrowsingContext {
  Element* owner;
  BrowsingContext* top = nullptr;
  BrowsingContext* Top() { return top ? top : this; }
  Element* GetEmbedderElement() { return owner; }
};
enum class PopupType { Menu };
struct nsIFrame {
  Element* content;
  Element* GetContent() { return content; }
};
struct nsMenuPopupFrame : nsIFrame {
  bool contextMenu;
  bool IsContextMenu() { return contextMenu; }
};
struct nsXULPopupManager {
  static nsXULPopupManager* instance;
  nsMenuPopupFrame* popup = nullptr;
  static nsXULPopupManager* GetInstance() { return instance; }
  nsIFrame* GetTopPopup(PopupType) { return popup; }
};
nsXULPopupManager* nsXULPopupManager::instance = nullptr;
enum { eMouseExitFromWidget, eMouseMove, eMouseEnterIntoWidget };
struct WidgetMouseEvent {
  enum Reason { eReal, eSynthesized };
  int mMessage;
  Reason mReason = eReal;
  int x = 37, y = 71, pointerId = 9;
};
class BrowserParent;
struct Table {
  std::vector<std::weak_ptr<BrowserParent>> actors;
  struct Iterator {
    Table& table;
    size_t position = 0;
    bool Done() { return position == table.actors.size(); }
    void Next() { ++position; }
    auto& Data() { return table.actors[position]; }
  };
  Iterator Iter() { return {*this}; }
};
auto do_QueryReferent(const std::weak_ptr<BrowserParent>& actor) {
  return actor.lock();
}
class BrowserParent {
 public:
  static Table* sLayerToBrowserParentTable;
  static BrowserParent* sLastMouseRemoteTarget;
  static uint64_t sContextMenuMouseEventId;
  static void UnsetLastMouseRemoteTarget(BrowserParent* actor) {
    if (sLastMouseRemoteTarget == actor) sLastMouseRemoteTarget = nullptr;
  }
  BrowsingContext context;
  bool mIsDestroyed = false;
  UniquePtr<WidgetMouseEvent> mContextMenuMouseExit;
  UniquePtr<WidgetMouseEvent> mContextMenuMouseMove;
  uint64_t mContextMenuMouseEventId = 0;
  void MouseEnterIntoWidget() {}
  std::vector<WidgetMouseEvent> delivered;
  explicit BrowserParent(Element* owner) : context{owner} {}
  BrowsingContext* GetBrowsingContext() { return &context; }
  static void FlushContextMenuMouseExits(Document&);
  void SendRealMouseEvent(WidgetMouseEvent&);
};
Table* BrowserParent::sLayerToBrowserParentTable = nullptr;
BrowserParent* BrowserParent::sLastMouseRemoteTarget = nullptr;
uint64_t BrowserParent::sContextMenuMouseEventId = 0;

// EXTRACTED_NATIVE_METHODS

int main() {
  Document first, second;
  Element owner{&first}, foreignOwner{&second};
  nsMenuPopupFrame contextMenu{{&owner}, true};
  nsMenuPopupFrame foreignMenu{{&foreignOwner}, true};
  nsMenuPopupFrame ordinaryPopup{{&owner}, false};
  nsXULPopupManager manager;
  nsXULPopupManager::instance = &manager;
  Table table;
  BrowserParent::sLayerToBrowserParentTable = &table;
  auto page = std::make_shared<BrowserParent>(&owner);
  auto frame = std::make_shared<BrowserParent>(nullptr);
  frame->context.top = &page->context;
  auto foreign = std::make_shared<BrowserParent>(&foreignOwner);
  table.actors = {page, frame, foreign, std::weak_ptr<BrowserParent>{}};
  WidgetMouseEvent exit{eMouseExitFromWidget};
  WidgetMouseEvent move{eMouseMove};
  WidgetMouseEvent enter{eMouseEnterIntoWidget};

  // Page and Fission child retain hover; an unrelated window receives input.
  manager.popup = &contextMenu;
  BrowserParent::sLastMouseRemoteTarget = frame.get();
  frame->SendRealMouseEvent(exit);
  assert(!BrowserParent::sLastMouseRemoteTarget);
  page->SendRealMouseEvent(exit);
  foreign->SendRealMouseEvent(move);
  assert(page->delivered.empty() && frame->delivered.empty());
  assert(foreign->delivered.size() == 1);
  BrowserParent::FlushContextMenuMouseExits(first);
  assert(page->delivered.empty() && frame->delivered.empty());

  // Moving across frames outside the menu is held. Only the last real target
  // resumes on closure; old moves must not activate other hovered elements.
  page->SendRealMouseEvent(move);
  page->SendRealMouseEvent(exit);
  frame->SendRealMouseEvent(enter);
  move.x = 91; move.y = 123;
  frame->SendRealMouseEvent(move);
  assert(page->delivered.empty() && frame->delivered.empty());
  manager.popup = nullptr;
  BrowserParent::FlushContextMenuMouseExits(first);
  assert(page->delivered.size() == 1 && frame->delivered.size() == 2);
  assert(page->delivered[0].mMessage == eMouseExitFromWidget);
  assert(frame->delivered[0].mMessage == eMouseExitFromWidget);
  assert(frame->delivered[0].x == exit.x && frame->delivered[0].y == exit.y);
  assert(frame->delivered[1].mMessage == eMouseMove);
  assert(frame->delivered[1].x == move.x && frame->delivered[1].y == move.y);
  BrowserParent::FlushContextMenuMouseExits(first);
  assert(frame->delivered.size() == 2);

  // A later real exit invalidates the earlier move: a pointer over the popup
  // or outside the browser must not restore an obsolete content target.
  manager.popup = &contextMenu;
  frame->SendRealMouseEvent(move);
  frame->SendRealMouseEvent(exit);
  manager.popup = nullptr;
  BrowserParent::FlushContextMenuMouseExits(first);
  assert(frame->delivered.size() == 3);
  assert(frame->delivered.back().mMessage == eMouseExitFromWidget);

  // Synthetic moves cannot supersede the last physical position.
  manager.popup = &contextMenu;
  frame->SendRealMouseEvent(move);
  WidgetMouseEvent synthesized{eMouseMove};
  synthesized.mReason = WidgetMouseEvent::eSynthesized;
  synthesized.x = 700;
  page->SendRealMouseEvent(synthesized);
  manager.popup = nullptr;
  BrowserParent::FlushContextMenuMouseExits(first);
  assert(page->delivered.size() == 1 && frame->delivered.size() == 4);
  assert(frame->delivered.back().x == move.x);

  // Keyboard-opened menus can see a move without an earlier widget exit.
  manager.popup = &contextMenu;
  page->SendRealMouseEvent(enter);
  manager.popup = nullptr;
  BrowserParent::FlushContextMenuMouseExits(first);
  assert(page->delivered.size() == 2);
  assert(page->delivered.back().mMessage == eMouseEnterIntoWidget);

  // Ordinary popups, missing popup managers and normal page moves are intact.
  manager.popup = &ordinaryPopup;
  page->SendRealMouseEvent(exit);
  nsXULPopupManager::instance = nullptr;
  page->SendRealMouseEvent(move);
  assert(page->delivered.size() == 4);
  nsXULPopupManager::instance = &manager;

  // Closing a different window cannot release this window's held movement.
  manager.popup = &foreignMenu;
  foreign->SendRealMouseEvent(move);
  BrowserParent::FlushContextMenuMouseExits(first);
  assert(foreign->delivered.size() == 1);
  manager.popup = nullptr;
  BrowserParent::FlushContextMenuMouseExits(second);
  assert(foreign->delivered.size() == 2);

  auto detached = std::make_shared<BrowserParent>(nullptr);
  manager.popup = &contextMenu;
  detached->SendRealMouseEvent(exit);
  assert(detached->delivered.size() == 1);
  page->mIsDestroyed = true;
  page->SendRealMouseEvent(move);
  assert(page->delivered.size() == 4);
  BrowserParent::sLayerToBrowserParentTable = nullptr;
  BrowserParent::FlushContextMenuMouseExits(first);
}
