{-# LANGUAGE TemplateHaskell #-}
-- | Core types for the punkin-pi TUI
module Punkin.Types where

import Brick.Widgets.Edit (Editor)
import Data.Text (Text)
import Data.Time (UTCTime)
import Data.Vector (Vector)
import GHC.Generics (Generic)
import Lens.Micro.TH (makeLenses)

-- | Widget names for focus handling
data Name
  = EditorWidget
  | MessageListWidget
  | ToolOutputWidget Int  -- indexed by tool call
  | ThinkingWidget Int    -- indexed by message
  | OverlayWidget Text
  deriving (Eq, Ord, Show)

-- | Message role
data Role = User | Assistant | System | ToolResult
  deriving (Eq, Show, Generic)

-- | Content block in a message
data Content
  = TextContent !Text
  | ThinkingContent !Text !Bool  -- content, expanded?
  | ToolCall !ToolCallInfo
  | ToolResultContent !ToolResultInfo
  | ImageContent !Text !Text  -- base64, media type
  deriving (Eq, Show, Generic)

-- | Tool call information
data ToolCallInfo = ToolCallInfo
  { _tcId     :: !Text
  , _tcName   :: !Text
  , _tcArgs   :: !Text  -- JSON string
  , _tcStatus :: !ToolStatus
  } deriving (Eq, Show, Generic)

-- | Tool execution status
data ToolStatus
  = ToolPending
  | ToolRunning
  | ToolSuccess
  | ToolError !Text
  deriving (Eq, Show, Generic)

-- | Tool result information
data ToolResultInfo = ToolResultInfo
  { _trId      :: !Text
  , _trContent :: !Text
  , _trIsError :: !Bool
  , _trExpanded :: !Bool
  } deriving (Eq, Show, Generic)

-- | A message in the conversation
data Message = Message
  { _msgRole      :: !Role
  , _msgContent   :: !(Vector Content)
  , _msgTimestamp :: !(Maybe UTCTime)
  , _msgModel     :: !(Maybe Text)
  } deriving (Eq, Show, Generic)

-- | Application state
data AppState = AppState
  { _messages         :: !(Vector Message)
  , _editor           :: !(Editor Text Name)
  , _scrollOffset     :: !Int
  , _focusedWidget    :: !Name
  , _thinkingExpanded :: !Bool  -- global toggle
  , _toolsExpanded    :: !Bool  -- global toggle
  , _status           :: !(Maybe Text)
  , _model            :: !Text
  , _thinkingLevel    :: !ThinkingLevel
  , _sessionId        :: !(Maybe Text)
  , _agentRunning     :: !Bool
  , _pendingInput     :: !(Maybe Text)
  } deriving (Show, Generic)

-- | Thinking level
data ThinkingLevel = ThinkingOff | ThinkingLow | ThinkingMedium | ThinkingHigh
  deriving (Eq, Show, Generic, Enum, Bounded)

-- | Events from the agent backend
data AgentEvent
  = MessageStart !Role
  | MessageDelta !Content
  | MessageEnd
  | ToolStart !ToolCallInfo
  | ToolUpdate !Text !Text  -- id, partial output
  | ToolEnd !Text !ToolStatus
  | StatusUpdate !Text
  | SessionInfo !Text !Text  -- session id, model
  | AgentError !Text
  deriving (Eq, Show, Generic)

-- | Commands to send to agent backend  
data AgentCommand
  = SendMessage !Text
  | CancelRequest
  | SwitchModel !Text
  | SetThinkingLevel !ThinkingLevel
  | ForkSession
  | NavigateTree !Text  -- entry id
  deriving (Eq, Show, Generic)

makeLenses ''ToolCallInfo
makeLenses ''ToolResultInfo
makeLenses ''Message
makeLenses ''AppState
