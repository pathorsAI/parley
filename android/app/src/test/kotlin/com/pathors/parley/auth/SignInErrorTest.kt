package com.pathors.parley.auth

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.CloudUser
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SignInErrorTest {

    @Test
    fun `a callback without a token did not finish`() {
        assertEquals(SignInError.DIDNT_FINISH, SignInError.fromCallback("no_session"))
        assertEquals(SignInError.DIDNT_FINISH, SignInError.fromCallback(AuthManager.NO_TOKEN))
        assertEquals(SignInError.DIDNT_FINISH, SignInError.fromCallback("please_restart_the_process"))
    }

    @Test
    fun `backing out says nothing`() {
        assertNull(SignInError.fromCallback("access_denied"))
        assertNull(SignInError.fromCallback("Cancelled"))
    }

    @Test
    fun `a token the cloud does not know is refused`() {
        assertEquals(SignInError.DIDNT_FINISH, SignInError.fromVerification(Result.success(null)))
        assertEquals(
            SignInError.DIDNT_FINISH,
            SignInError.fromVerification(Result.failure(CloudException(401, "unauthorized"))),
        )
    }

    @Test
    fun `a good token is kept through a flaky network or a server error`() {
        assertNull(SignInError.fromVerification(Result.success(CloudUser(id = "u", email = "a@b.c"))))
        assertNull(SignInError.fromVerification(Result.failure(IOException("offline"))))
        assertNull(SignInError.fromVerification(Result.failure(CloudException(503, "unavailable"))))
    }
}
