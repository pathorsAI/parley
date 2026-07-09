cmake_minimum_required(VERSION 3.16.0)

project(ParleyVirtualMic CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Identity of the .driver bundle. DRIVER_UID must match the CFPlugInFactories key
# in Info.plist.in; DRIVER_ENTRYPOINT is the C entry function in the source.
set(DRIVER_NAME "ParleyMicrophone")
set(DRIVER_VERSION "0.1.0")
set(DRIVER_COPYRIGHT "Copyright (c) Pathors")
set(DRIVER_IDENTIFIER "com.pathors.parley.virtualmic")
set(DRIVER_UID "1AFCCF31-DDB9-4D45-BA4A-1E0461B8C79D")
set(DRIVER_ENTRYPOINT "ParleyVirtualMicEntryPoint")

# Optional Developer ID for signing the bundle (empty = unsigned / ad-hoc later).
set(CODESIGN_ID "" CACHE STRING "codesign identity for the .driver bundle")

# --- libASPL (MIT): AudioServerPlugIn boilerplate -------------------------------
# Pinned to a specific commit for reproducible builds. For an offline / local
# build, point FETCHCONTENT_SOURCE_DIR_LIBASPL at a checkout to skip the network.
include(FetchContent)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  libASPL
  GIT_REPOSITORY https://github.com/gavv/libASPL.git
  GIT_TAG 633e0f70203edd87d320fc5a3cae901e1363aac5
)
FetchContent_MakeAvailable(libASPL)

# --- the driver ----------------------------------------------------------------
# MODULE → a Mach-O loadable bundle (the plugin binary), packed into a macOS
# bundle directory named "${DRIVER_NAME}.driver".
add_library(${DRIVER_NAME} MODULE src/ParleyVirtualMic.cpp)

target_link_libraries(${DRIVER_NAME} PRIVATE libASPL)

find_library(LIB_CoreFoundation CoreFoundation REQUIRED)
target_link_libraries(${DRIVER_NAME} PRIVATE ${LIB_CoreFoundation})

set_target_properties(${DRIVER_NAME} PROPERTIES
  OUTPUT_NAME "${DRIVER_NAME}"
  PREFIX ""
  SUFFIX ""
  BUNDLE true
  BUNDLE_EXTENSION "driver"
  MACOSX_BUNDLE ON
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in"
  MACOSX_BUNDLE_BUNDLE_NAME "${DRIVER_NAME}"
  MACOSX_BUNDLE_BUNDLE_VERSION "${DRIVER_VERSION}"
  MACOSX_BUNDLE_SHORT_VERSION_STRING "${DRIVER_VERSION}"
  MACOSX_BUNDLE_COPYRIGHT "${DRIVER_COPYRIGHT}"
  MACOSX_BUNDLE_GUI_IDENTIFIER "${DRIVER_IDENTIFIER}"
)

# Sign the finished bundle when a Developer ID is provided (required for a
# notarized, Gatekeeper-friendly install; unsigned builds load only for local
# dev after an ad-hoc sign — see install-dev.sh).
if(NOT CODESIGN_ID STREQUAL "")
  add_custom_command(TARGET ${DRIVER_NAME} POST_BUILD
    VERBATIM
    COMMENT "Signing ${DRIVER_NAME}.driver with ${CODESIGN_ID}"
    COMMAND codesign --force --options runtime --timestamp
      -s "${CODESIGN_ID}"
      "$<TARGET_BUNDLE_DIR:${DRIVER_NAME}>"
  )
endif()
