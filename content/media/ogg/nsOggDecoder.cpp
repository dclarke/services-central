/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla code.
 *
 * The Initial Developer of the Original Code is the Mozilla Corporation.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Chris Double <chris.double@double.co.nz>
 *  Chris Pearce <chris@pearce.org.nz>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

#include "nsOggPlayStateMachine.h"
#include <limits>
#include "nsNetUtil.h"
#include "nsAudioStream.h"
#include "nsHTMLVideoElement.h"
#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsTArray.h"
#include "nsOggCodecState.h"
#include "nsOggDecoder.h"
#include "nsOggReader.h"

#ifdef PR_LOGGING
PRLogModuleInfo* gOggDecoderLog;
#define LOG(type, msg) PR_LOG(gOggDecoderLog, type, msg)
#else
#define LOG(type, msg)
#endif

NS_IMPL_THREADSAFE_ISUPPORTS1(nsOggDecoder, nsIObserver)

void nsOggDecoder::Pause() 
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  MonitorAutoEnter mon(mMonitor);
  if (mPlayState == PLAY_STATE_SEEKING || mPlayState == PLAY_STATE_ENDED) {
    mNextState = PLAY_STATE_PAUSED;
    return;
  }

  ChangeState(PLAY_STATE_PAUSED);
}

void nsOggDecoder::SetVolume(float volume)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  mInitialVolume = volume;
  if (mDecodeStateMachine) {
    mDecodeStateMachine->SetVolume(volume);
  }
}

float nsOggDecoder::GetDuration()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mDuration >= 0) {
     return static_cast<float>(mDuration) / 1000.0;
  }
  return std::numeric_limits<float>::quiet_NaN();
}

nsOggDecoder::nsOggDecoder() :
  mDecoderPosition(0),
  mPlaybackPosition(0),
  mCurrentTime(0.0),
  mInitialVolume(0.0),
  mRequestedSeekTime(-1.0),
  mDuration(-1),
  mSeekable(PR_TRUE),
  mMonitor("media.decoder"),
  mPlayState(PLAY_STATE_PAUSED),
  mNextState(PLAY_STATE_PAUSED),
  mResourceLoaded(PR_FALSE),
  mIgnoreProgressData(PR_FALSE)
{
  MOZ_COUNT_CTOR(nsOggDecoder);
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
#ifdef PR_LOGGING
  if (!gOggDecoderLog) {
    gOggDecoderLog = PR_NewLogModule("nsOggDecoder");
  }
#endif
}

PRBool nsOggDecoder::Init(nsHTMLMediaElement* aElement)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (!nsMediaDecoder::Init(aElement))
    return PR_FALSE;

  nsContentUtils::RegisterShutdownObserver(this);
  mImageContainer = aElement->GetImageContainer();
  return PR_TRUE;
}

void nsOggDecoder::Stop()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread");

  // The decode thread must die before the state machine can die.
  // The state machine must die before the reader.
  // The state machine must die before the decoder.
  if (mStateMachineThread)
    mStateMachineThread->Shutdown();

  mStateMachineThread = nsnull;
  mDecodeStateMachine = nsnull;
}

void nsOggDecoder::Shutdown()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  
  if (mShuttingDown)
    return;

  mShuttingDown = PR_TRUE;

  // This changes the decoder state to SHUTDOWN and does other things
  // necessary to unblock the state machine thread if it's blocked, so
  // the asynchronous shutdown in nsDestroyStateMachine won't deadlock.
  if (mDecodeStateMachine) {
    mDecodeStateMachine->Shutdown();
  }

  // Force any outstanding seek and byterange requests to complete
  // to prevent shutdown from deadlocking.
  if (mStream) {
    mStream->Close();
  }

  ChangeState(PLAY_STATE_SHUTDOWN);
  nsMediaDecoder::Shutdown();

  // We can't destroy mDecodeStateMachine until mStateMachineThread is shut down.
  // It's unsafe to Shutdown() the decode thread here, as
  // nsIThread::Shutdown() may run events, such as JS event handlers,
  // and we could be running at an unsafe time such as during element
  // destruction.
  // So we destroy the decoder on the main thread in an asynchronous event.
  // See bug 468721.
  nsCOMPtr<nsIRunnable> event =
    NS_NewRunnableMethod(this, &nsOggDecoder::Stop);
  NS_DispatchToMainThread(event, NS_DISPATCH_NORMAL);

  nsContentUtils::UnregisterShutdownObserver(this);
}

nsOggDecoder::~nsOggDecoder()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  MOZ_COUNT_DTOR(nsOggDecoder);
}

nsresult nsOggDecoder::Load(nsMediaStream* aStream,
                            nsIStreamListener** aStreamListener)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (aStreamListener) {
    *aStreamListener = nsnull;
  }

  {
    // Hold the lock while we do this to set proper lock ordering
    // expectations for dynamic deadlock detectors: decoder lock(s)
    // should be grabbed before the cache lock
    MonitorAutoEnter mon(mMonitor);

    nsresult rv = aStream->Open(aStreamListener);
    if (NS_FAILED(rv)) {
      delete aStream;
      return rv;
    }

    mStream = aStream;
  }

  nsresult rv = NS_NewThread(getter_AddRefs(mStateMachineThread));
  NS_ENSURE_SUCCESS(rv, rv);

  mDecodeStateMachine = new nsOggPlayStateMachine(this);
  if (NS_FAILED(mDecodeStateMachine->Init())) {
    return NS_ERROR_FAILURE;
  }
  {
    MonitorAutoEnter mon(mMonitor);
    mDecodeStateMachine->SetSeekable(mSeekable);
    mDecodeStateMachine->SetDuration(mDuration);
  }

  ChangeState(PLAY_STATE_LOADING);

  return mStateMachineThread->Dispatch(mDecodeStateMachine, NS_DISPATCH_NORMAL);
}

nsresult nsOggDecoder::Play()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  MonitorAutoEnter mon(mMonitor);
  if (mPlayState == PLAY_STATE_SEEKING) {
    mNextState = PLAY_STATE_PLAYING;
    return NS_OK;
  }
  if (mPlayState == PLAY_STATE_ENDED)
    return Seek(0);

  ChangeState(PLAY_STATE_PLAYING);

  return NS_OK;
}

nsresult nsOggDecoder::Seek(float aTime)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  MonitorAutoEnter mon(mMonitor);

  if (aTime < 0.0)
    return NS_ERROR_FAILURE;

  mRequestedSeekTime = aTime;

  // If we are already in the seeking state, then setting mRequestedSeekTime
  // above will result in the new seek occurring when the current seek
  // completes.
  if (mPlayState != PLAY_STATE_SEEKING) {
    if (mPlayState == PLAY_STATE_ENDED) {
      mNextState = PLAY_STATE_PLAYING;
    } else {
      mNextState = mPlayState;
    }
    ChangeState(PLAY_STATE_SEEKING);
  }

  return NS_OK;
}

nsresult nsOggDecoder::PlaybackRateChanged()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  return NS_ERROR_NOT_IMPLEMENTED;
}

float nsOggDecoder::GetCurrentTime()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  return mCurrentTime;
}

nsMediaStream* nsOggDecoder::GetCurrentStream()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  return mStream;
}

already_AddRefed<nsIPrincipal> nsOggDecoder::GetCurrentPrincipal()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  return mStream ? mStream->GetCurrentPrincipal() : nsnull;
}

void nsOggDecoder::MetadataLoaded()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mShuttingDown)
    return;

  // Only inform the element of MetadataLoaded if not doing a load() in order
  // to fulfill a seek, otherwise we'll get multiple metadataloaded events.
  PRBool notifyElement = PR_TRUE;
  {
    MonitorAutoEnter mon(mMonitor);
    mDuration = mDecodeStateMachine ? mDecodeStateMachine->GetDuration() : -1;
    notifyElement = mNextState != PLAY_STATE_SEEKING;
  }

  if (mElement && notifyElement) {
    // Make sure the element and the frame (if any) are told about
    // our new size.
    Invalidate();
    mElement->MetadataLoaded();
  }

  if (!mResourceLoaded) {
    StartProgress();
  } else if (mElement) {
    // Resource was loaded during metadata loading, when progress
    // events are being ignored. Fire the final progress event.
    mElement->DispatchAsyncProgressEvent(NS_LITERAL_STRING("progress"));
  }

  // Only inform the element of FirstFrameLoaded if not doing a load() in order
  // to fulfill a seek, otherwise we'll get multiple loadedfirstframe events.
  PRBool resourceIsLoaded = !mResourceLoaded && mStream &&
    mStream->IsDataCachedToEndOfStream(mDecoderPosition);
  if (mElement && notifyElement) {
    mElement->FirstFrameLoaded(resourceIsLoaded);
  }

  // The element can run javascript via events
  // before reaching here, so only change the
  // state if we're still set to the original
  // loading state.
  MonitorAutoEnter mon(mMonitor);
  if (mPlayState == PLAY_STATE_LOADING) {
    if (mRequestedSeekTime >= 0.0) {
      ChangeState(PLAY_STATE_SEEKING);
    } else {
      ChangeState(mNextState);
    }
  }

  if (resourceIsLoaded) {
    ResourceLoaded();
  }
}

void nsOggDecoder::ResourceLoaded()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");

  // Don't handle ResourceLoaded if we are shutting down, or if
  // we need to ignore progress data due to seeking (in the case
  // that the seek results in reaching end of file, we get a bogus call
  // to ResourceLoaded).
  if (mShuttingDown)
    return;

  {
    // If we are seeking or loading then the resource loaded notification we get
    // should be ignored, since it represents the end of the seek request.
    MonitorAutoEnter mon(mMonitor);
    if (mIgnoreProgressData || mResourceLoaded || mPlayState == PLAY_STATE_LOADING)
      return;

    Progress(PR_FALSE);

    mResourceLoaded = PR_TRUE;
    StopProgress();
  }

  // Ensure the final progress event gets fired
  if (mElement) {
    mElement->DispatchAsyncProgressEvent(NS_LITERAL_STRING("progress"));
    mElement->ResourceLoaded();
  }
}

void nsOggDecoder::NetworkError()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mShuttingDown)
    return;

  if (mElement)
    mElement->NetworkError();

  Shutdown();
}

void nsOggDecoder::DecodeError()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mShuttingDown)
    return;

  if (mElement)
    mElement->DecodeError();

  Shutdown();
}

PRBool nsOggDecoder::IsSeeking() const
{
  return mPlayState == PLAY_STATE_SEEKING || mNextState == PLAY_STATE_SEEKING;
}

PRBool nsOggDecoder::IsEnded() const
{
  return mPlayState == PLAY_STATE_ENDED || mPlayState == PLAY_STATE_SHUTDOWN;
}

void nsOggDecoder::PlaybackEnded()
{
  if (mShuttingDown || mPlayState == nsOggDecoder::PLAY_STATE_SEEKING)
    return;

  PlaybackPositionChanged();
  ChangeState(PLAY_STATE_ENDED);

  if (mElement)  {
    UpdateReadyStateForData();
    mElement->PlaybackEnded();
  }
}

NS_IMETHODIMP nsOggDecoder::Observe(nsISupports *aSubjet,
                                    const char *aTopic,
                                    const PRUnichar *someData)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (strcmp(aTopic, NS_XPCOM_SHUTDOWN_OBSERVER_ID) == 0) {
    Shutdown();
  }

  return NS_OK;
}

nsMediaDecoder::Statistics
nsOggDecoder::GetStatistics()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  Statistics result;

  MonitorAutoEnter mon(mMonitor);
  if (mStream) {
    result.mDownloadRate = 
      mStream->GetDownloadRate(&result.mDownloadRateReliable);
    result.mDownloadPosition =
      mStream->GetCachedDataEnd(mDecoderPosition);
    result.mTotalBytes = mStream->GetLength();
    result.mPlaybackRate = ComputePlaybackRate(&result.mPlaybackRateReliable);
    result.mDecoderPosition = mDecoderPosition;
    result.mPlaybackPosition = mPlaybackPosition;
  } else {
    result.mDownloadRate = 0;
    result.mDownloadRateReliable = PR_TRUE;
    result.mPlaybackRate = 0;
    result.mPlaybackRateReliable = PR_TRUE;
    result.mDecoderPosition = 0;
    result.mPlaybackPosition = 0;
    result.mDownloadPosition = 0;
    result.mTotalBytes = 0;
  }

  return result;
}

double nsOggDecoder::ComputePlaybackRate(PRPackedBool* aReliable)
{
  GetMonitor().AssertCurrentThreadIn();
  NS_ASSERTION(NS_IsMainThread() || IsThread(mStateMachineThread),
               "Should be on main or state machine thread.");

  PRInt64 length = mStream ? mStream->GetLength() : -1;
  if (mDuration >= 0 && length >= 0) {
    *aReliable = PR_TRUE;
    return double(length)*1000.0/mDuration;
  }
  return mPlaybackStatistics.GetRateAtLastStop(aReliable);
}

void nsOggDecoder::UpdatePlaybackRate()
{
  NS_ASSERTION(NS_IsMainThread() || IsThread(mStateMachineThread),
               "Should be on main or state machine thread.");
  GetMonitor().AssertCurrentThreadIn();
  if (!mStream)
    return;
  PRPackedBool reliable;
  PRUint32 rate = PRUint32(ComputePlaybackRate(&reliable));
  if (reliable) {
    // Avoid passing a zero rate
    rate = NS_MAX(rate, 1u);
  } else {
    // Set a minimum rate of 10,000 bytes per second ... sometimes we just
    // don't have good data
    rate = NS_MAX(rate, 10000u);
  }
  mStream->SetPlaybackRate(rate);
}

void nsOggDecoder::NotifySuspendedStatusChanged()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (!mStream)
    return;
  if (mStream->IsSuspendedByCache() && mElement) {
    // if this is an autoplay element, we need to kick off its autoplaying
    // now so we consume data and hopefully free up cache space
    mElement->NotifyAutoplayDataReady();
  }
}

void nsOggDecoder::NotifyBytesDownloaded()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  UpdateReadyStateForData();
  Progress(PR_FALSE);
}

void nsOggDecoder::NotifyDownloadEnded(nsresult aStatus)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");

  if (aStatus == NS_BINDING_ABORTED)
    return;

  {
    MonitorAutoEnter mon(mMonitor);
    UpdatePlaybackRate();
  }

  if (NS_SUCCEEDED(aStatus)) {
    ResourceLoaded();
  } else if (aStatus != NS_BASE_STREAM_CLOSED) {
    NetworkError();
  }
  UpdateReadyStateForData();
}

void nsOggDecoder::NotifyBytesConsumed(PRInt64 aBytes)
{
  MonitorAutoEnter mon(mMonitor);
  NS_ASSERTION(mDecodeStateMachine->OnStateMachineThread() || mDecodeStateMachine->OnDecodeThread(),
               "Should be on play state machine or decode thread.");
  if (!mIgnoreProgressData) {
    mDecoderPosition += aBytes;
  }
}

void nsOggDecoder::NextFrameUnavailableBuffering()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be called on main thread");
  if (!mElement || mShuttingDown || !mDecodeStateMachine)
    return;

  mElement->UpdateReadyStateForData(nsHTMLMediaElement::NEXT_FRAME_UNAVAILABLE_BUFFERING);
}

void nsOggDecoder::NextFrameAvailable()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be called on main thread");
  if (!mElement || mShuttingDown || !mDecodeStateMachine)
    return;

  mElement->UpdateReadyStateForData(nsHTMLMediaElement::NEXT_FRAME_AVAILABLE);
}

void nsOggDecoder::NextFrameUnavailable()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be called on main thread");
  if (!mElement || mShuttingDown || !mDecodeStateMachine)
    return;

  mElement->UpdateReadyStateForData(nsHTMLMediaElement::NEXT_FRAME_UNAVAILABLE);
}

void nsOggDecoder::UpdateReadyStateForData()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be called on main thread");
  if (!mElement || mShuttingDown || !mDecodeStateMachine)
    return;

  nsHTMLMediaElement::NextFrameStatus frameStatus =
    mDecodeStateMachine->GetNextFrameStatus();
  mElement->UpdateReadyStateForData(frameStatus);
}

void nsOggDecoder::SeekingStopped()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");

  if (mShuttingDown)
    return;

  {
    MonitorAutoEnter mon(mMonitor);

    // An additional seek was requested while the current seek was
    // in operation.
    if (mRequestedSeekTime >= 0.0)
      ChangeState(PLAY_STATE_SEEKING);
    else
      ChangeState(mNextState);
  }

  if (mElement) {
    UpdateReadyStateForData();
    mElement->SeekCompleted();
  }
}

// This is called when seeking stopped *and* we're at the end of the
// media.
void nsOggDecoder::SeekingStoppedAtEnd()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");

  if (mShuttingDown)
    return;

  PRBool fireEnded = PR_FALSE;
  {
    MonitorAutoEnter mon(mMonitor);

    // An additional seek was requested while the current seek was
    // in operation.
    if (mRequestedSeekTime >= 0.0) {
      ChangeState(PLAY_STATE_SEEKING);
    } else {
      fireEnded = mNextState != PLAY_STATE_PLAYING;
      ChangeState(fireEnded ? PLAY_STATE_ENDED : mNextState);
    }
  }

  if (mElement) {
    UpdateReadyStateForData();
    mElement->SeekCompleted();
    if (fireEnded) {
      mElement->PlaybackEnded();
    }
  }
}

void nsOggDecoder::SeekingStarted()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mShuttingDown)
    return;

  if (mElement) {
    UpdateReadyStateForData();
    mElement->SeekStarted();
  }
}

void nsOggDecoder::ChangeState(PlayState aState)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");   
  MonitorAutoEnter mon(mMonitor);

  if (mNextState == aState) {
    mNextState = PLAY_STATE_PAUSED;
  }

  if (mPlayState == PLAY_STATE_SHUTDOWN) {
    mMonitor.NotifyAll();
    return;
  }

  mPlayState = aState;
  switch (aState) {
  case PLAY_STATE_PAUSED:
    /* No action needed */
    break;
  case PLAY_STATE_PLAYING:
    mDecodeStateMachine->Decode();
    break;
  case PLAY_STATE_SEEKING:
    mDecodeStateMachine->Seek(mRequestedSeekTime);
    mRequestedSeekTime = -1.0;
    break;
  case PLAY_STATE_LOADING:
    /* No action needed */
    break;
  case PLAY_STATE_START:
    /* No action needed */
    break;
  case PLAY_STATE_ENDED:
    /* No action needed */
    break;
  case PLAY_STATE_SHUTDOWN:
    /* No action needed */
    break;
  }
  mMonitor.NotifyAll();
}

void nsOggDecoder::PlaybackPositionChanged()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mShuttingDown)
    return;

  float lastTime = mCurrentTime;

  // Control the scope of the monitor so it is not
  // held while the timeupdate and the invalidate is run.
  {
    MonitorAutoEnter mon(mMonitor);

    if (mDecodeStateMachine) {
      mCurrentTime = mDecodeStateMachine->GetCurrentTime();
      mDecodeStateMachine->ClearPositionChangeFlag();
    }
  }

  // Invalidate the frame so any video data is displayed.
  // Do this before the timeupdate event so that if that
  // event runs JavaScript that queries the media size, the
  // frame has reflowed and the size updated beforehand.
  Invalidate();

  if (mElement && lastTime != mCurrentTime) {
    mElement->DispatchSimpleEvent(NS_LITERAL_STRING("timeupdate"));
  }
}

void nsOggDecoder::DurationChanged()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  MonitorAutoEnter mon(mMonitor);
  PRInt64 oldDuration = mDuration;
  mDuration = mDecodeStateMachine ? mDecodeStateMachine->GetDuration() : -1;
  if (mElement && oldDuration != mDuration) {
    LOG(PR_LOG_DEBUG, ("%p duration changed to %lldms", this, mDuration));
    mElement->DispatchSimpleEvent(NS_LITERAL_STRING("durationchange"));
  }
}

void nsOggDecoder::SetDuration(PRInt64 aDuration)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  mDuration = aDuration;
  if (mDecodeStateMachine) {
    MonitorAutoEnter mon(mMonitor);
    mDecodeStateMachine->SetDuration(mDuration);
    UpdatePlaybackRate();
  }
}

void nsOggDecoder::SetSeekable(PRBool aSeekable)
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  mSeekable = aSeekable;
  if (mDecodeStateMachine) {
    MonitorAutoEnter mon(mMonitor);
    mDecodeStateMachine->SetSeekable(aSeekable);
  }
}

PRBool nsOggDecoder::GetSeekable()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  return mSeekable;
}

void nsOggDecoder::Suspend()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mStream) {
    mStream->Suspend(PR_TRUE);
  }
}

void nsOggDecoder::Resume()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mStream) {
    mStream->Resume();
  }
}

void nsOggDecoder::StopProgressUpdates()
{
  NS_ASSERTION(IsThread(mStateMachineThread), "Should be on state machine thread.");
  mIgnoreProgressData = PR_TRUE;
  if (mStream) {
    mStream->SetReadMode(nsMediaCacheStream::MODE_METADATA);
  }
}

void nsOggDecoder::StartProgressUpdates()
{
  NS_ASSERTION(IsThread(mStateMachineThread), "Should be on state machine thread.");
  mIgnoreProgressData = PR_FALSE;
  if (mStream) {
    mStream->SetReadMode(nsMediaCacheStream::MODE_PLAYBACK);
    mDecoderPosition = mPlaybackPosition = mStream->Tell();
  }
}

void nsOggDecoder::MoveLoadsToBackground()
{
  NS_ASSERTION(NS_IsMainThread(), "Should be on main thread.");
  if (mStream) {
    mStream->MoveLoadsToBackground();
  }
}
